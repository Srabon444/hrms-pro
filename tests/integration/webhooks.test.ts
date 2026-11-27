import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { hashPassword } from '../../src/lib/server/auth/password';
import { confirmRecentAuth } from '../../src/lib/server/auth/service';
import { createSession } from '../../src/lib/server/auth/session';
import { closePools, ownerPool } from '../../src/lib/server/db';
import {
	leaveTypes,
	memberships,
	notifications,
	tenantSettings,
	webhookDeliveries,
	webhookEndpoints
} from '../../src/lib/server/db/schema';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS, updateEmployee } from '../../src/lib/server/employees';
import { recordExit } from '../../src/lib/server/exits';
import { cancelLeave, decideLeave, requestLeave } from '../../src/lib/server/leave-requests';
import { addHoliday } from '../../src/lib/server/org';
import { updateOwnDetails } from '../../src/lib/server/profile';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { queue, closeQueues } from '../../src/lib/server/queue';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { afterCommit, systemCtx, withTenant } from '../../src/lib/server/tenancy';
import {
	createWebhook,
	deleteWebhook,
	deliverWebhook,
	rotateWebhookSecret,
	runWebhooks,
	setWebhookActive,
	WEBHOOK_DISABLE_AFTER,
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_MAX_ENDPOINTS,
	type Sender
} from '../../src/lib/server/webhooks';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
type Sent = { url: string; headers: Record<string, string>; body: string };
let tenant: Tenant;
let other: Tenant;
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const PASSWORD = 'correct horse battery staple 42';
const URL_A = 'https://hooks.example.com/hrms';
const sys = (t = tenant) => systemCtx(t.id);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const hr = {
	membershipId: '',
	employeeId: null,
	grants: {
		'employee.read': ['all'],
		'employee.create': ['all'],
		'employee.update': ['all'],
		'employee.sensitive.update': ['all']
	},
	roleKeys: [],
	isOwner: false
};
const today = dateIn(new Date(), 'Asia/Dhaka');
const month = Number(today.slice(5, 7));
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const work = (from: string) => {
	let d = from;
	while (weekday(d) === 5 || weekday(d) === 6) d = addDays(d, 1);
	return d;
};
const hire = (t: Tenant, fullName: string, extra: Record<string, string> = {}) =>
	createEmployee({ tenantId: t.id, actor: 'user' }, hr as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		gender: 'male',
		joinDate: addDays(today, -400),
		...extra
	});

async function member(t: Tenant, key: string, roleKeys: string[], employeeId: string | null = null) {
	const u = await createUser();
	await ownerPool().sql`update users set password_hash = ${await hashPassword(PASSWORD)} where id = ${u.id}`;
	const id = await withTenant(sys(t), async (tx) => {
		const membershipId = await addMember(tx, t.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	const { token } = await createSession(u.id, {});
	who[key] = {
		user: { userId: u.id, sessionId: sha256(token), totpEnabled: false },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: await loadAccess(t.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const confirmed = async (key: string) => confirmRecentAuth(who[key].user, PASSWORD, '');

async function endpoint(key: string, url = URL_A, events = ['employee.created', 'employee.updated']) {
	await confirmed(key);
	const secret = await createWebhook(who[key], { url, events });
	const [row] = await withTenant(sys(who[key].tenant), (tx) =>
		tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.url, url))
	);
	return { secret, id: row.id };
}

const deliveries = (t = tenant) =>
	withTenant(sys(t), (tx) => tx.select().from(webhookDeliveries).orderBy(webhookDeliveries.createdAt));
const deliveriesFor = async (endpointId: string) => (await deliveries()).filter((d) => d.endpointId === endpointId);

const capture = (status = 200) => {
	const sent: Sent[] = [];
	const send: Sender = async (url, init) => {
		sent.push({ url, headers: init.headers, body: init.body });
		return { status, body: '' };
	};
	return { sent, send };
};

const drain = async (endpointId: string, send: Sender) => {
	for (const d of await deliveriesFor(endpointId))
		if (d.status === 'pending')
			await deliverWebhook({ tenantId: tenant.id, deliveryId: d.id, attempt: d.attempts }, send);
};

const wipe = async () => {
	await withTenant(sys(), (tx) => tx.delete(webhookEndpoints));
	await withTenant(sys(other), (tx) => tx.delete(webhookEndpoints));
};

beforeAll(async () => {
	tenant = await createTenant('hook');
	other = await createTenant('hookb');
	await withTenant(sys(), async (tx) => {
		await seedTenant(tx, tenant.id, TEST_LOCALE);
		await tx.update(tenantSettings).set({ fiscalYearStartMonth: month });
	});
	await withTenant(sys(other), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	ids.boss = await hire(tenant, 'Bo Boss');
	ids.staff = await hire(tenant, 'Sam Staff', { managerId: ids.boss });
	await member(tenant, 'own', ['owner']);
	await member(tenant, 'boss', ['line_manager'], ids.boss);
	await member(tenant, 'staff', [], ids.staff);
	await member(other, 'olga', ['owner']);
	const r = await redisReady();
	await r.del(...Object.values(who).map((m) => rkey('rl', 'reauth', m.user.userId)));
});

afterAll(async () => {
	await closeQueues();
	await closeRedis();
	await closePools();
});

describe('after commit hooks', () => {
	it('run once the transaction commits and never after a rollback', async () => {
		const ran: string[] = [];
		await withTenant(sys(), async () => {
			afterCommit(async () => void ran.push('commit'));
			expect(ran).toEqual([]);
		});
		await withTenant(sys(), async () => {
			afterCommit(async () => void ran.push('rollback'));
			throw new Error('stop');
		}).catch(() => undefined);
		await withTenant(sys(), async () => {
			afterCommit(async () => {
				throw new Error('hook broke');
			});
		});
		expect(ran).toEqual(['commit']);
		expect(() => afterCommit(async () => undefined)).toThrow('outside a tenant transaction');
	});
});

describe('webhook endpoints', () => {
	it('need api.manage, a fresh password and a safe https address', async () => {
		await wipe();
		expect(await code(createWebhook(who.staff, { url: URL_A, events: ['employee.created'] }))).toBe('forbidden');
		expect(await code(createWebhook(who.own, { url: URL_A, events: ['employee.created'] }))).toBe('reauth_required');
		await confirmed('own');
		for (const url of [
			'http://hooks.example.com/x',
			'https://hooks.example.com:8443/x',
			'https://u:p@hooks.example.com/x',
			'https://10.0.0.5/x',
			'https://[::ffff:127.0.0.1]/x',
			'https://169.254.169.254/latest/meta-data'
		])
			expect(await code(createWebhook(who.own, { url, events: ['employee.created'] }))).toBe('unsafe_url');
		expect(await code(createWebhook(who.own, { url: URL_A, events: [] }))).toBe('invalid');
		expect(await code(createWebhook(who.own, { url: URL_A, events: ['payroll.run'] }))).toBe('invalid');
		const secret = await createWebhook(who.own, {
			url: URL_A,
			events: ['employee.created', 'employee.created']
		});
		expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
		const [row] = await withTenant(sys(), (tx) => tx.select().from(webhookEndpoints));
		expect(row.events).toEqual(['employee.created']);
		expect(row.secretEnc).not.toContain(secret.slice(6));
		const [{ n }] = await ownerPool().sql<{ n: number }[]>`
			select count(*)::int as n from audit_log where table_name = 'webhook_endpoints' and event = 'webhook.create' and row_id = ${row.id}`;
		expect(n).toBe(1);
	});

	it('stay inside their tenant and cap at the limit', async () => {
		await wipe();
		await endpoint('own');
		expect((await withTenant(sys(other), (tx) => tx.select().from(webhookEndpoints))).length).toBe(0);
		const [mine] = await withTenant(sys(), (tx) => tx.select().from(webhookEndpoints));
		expect(await code(deleteWebhook(who.olga, mine.id))).toBe('not_found');
		expect(await code(setWebhookActive(who.olga, mine.id, false))).toBe('not_found');
		await confirmed('olga');
		expect(await code(rotateWebhookSecret(who.olga, mine.id))).toBe('not_found');
		for (let i = 1; i < WEBHOOK_MAX_ENDPOINTS; i++)
			await createWebhook(who.own, { url: `${URL_A}/${i}`, events: ['employee.created'] });
		expect(await code(createWebhook(who.own, { url: `${URL_A}/over`, events: ['employee.created'] }))).toBe('limit');
	});
});

describe('emitting events', () => {
	it('writes one delivery per subscribed, active endpoint inside the same transaction', async () => {
		await wipe();
		const created = await endpoint('own', URL_A, ['employee.created']);
		const updated = await endpoint('own', `${URL_A}/u`, ['employee.updated']);
		const off = await endpoint('own', `${URL_A}/off`, ['employee.created']);
		await setWebhookActive(who.own, off.id, false);
		await endpoint('olga', `${URL_A}/other`, ['employee.created']);
		const id = await hire(tenant, 'Nia New');
		const list = await deliveries();
		expect(list.map((d) => [d.endpointId, d.event, d.data])).toEqual([
			[created.id, 'employee.created', { employeeId: id }]
		]);
		expect(list[0].status).toBe('pending');
		expect(await deliveries(other)).toEqual([]);
		await updateEmployee(
			{ tenantId: tenant.id, actor: 'user' },
			hr as never,
			id,
			{
				...blanks,
				fullName: 'Nia Newer',
				employmentType: 'full_time',
				status: 'active',
				gender: 'male',
				joinDate: addDays(today, -400)
			},
			tenant.slug
		);
		expect((await deliveriesFor(updated.id)).map((d) => d.data)).toEqual([{ employeeId: id }]);
		expect((await queue('webhooks').getJob(`wh-${list[0].id}-0`))?.data).toEqual({
			tenantId: tenant.id,
			deliveryId: list[0].id,
			attempt: 0
		});
	});

	it('covers self-service details, exits and leave cut short by a new holiday', async () => {
		await wipe();
		const people = await endpoint('own', URL_A, ['employee.updated']);
		const leave = await endpoint('own', `${URL_A}/leave`, ['leave_request.updated']);
		const mover = await hire(tenant, 'Mo Mover');
		await updateOwnDetails({ tenantId: tenant.id, actor: 'user' }, who.staff.access, ids.staff, {
			phone: '01711000000',
			personalEmail: '',
			presentAddress: '',
			permanentAddress: ''
		});
		await recordExit(who.own, mover, { exitDate: addDays(today, 40), exitType: 'resignation', exitReason: '' });
		expect((await deliveriesFor(people.id)).map((d) => d.data.employeeId)).toEqual([ids.staff, mover]);
		const casual = (
			await withTenant(sys(), (tx) => tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'casual')))
		)[0].id;
		const day = work(addDays(today, 50));
		const asked = await requestLeave(who.staff, {
			leaveTypeId: casual,
			startDate: day,
			endDate: '',
			session: 'full',
			reason: ''
		});
		await addHoliday(sys(), { date: day, name: 'Surprise day' });
		expect((await deliveriesFor(leave.id)).map((d) => d.data.leaveRequestId)).toEqual([asked]);
	});

	it('writes nothing when the change rolls back', async () => {
		await wipe();
		await endpoint('own', URL_A, ['employee.created']);
		const bad = await code(hire(tenant, 'Ro Rollback', { managerId: crypto.randomUUID() }));
		expect(bad).not.toBe('ok');
		expect(await deliveries()).toEqual([]);
	});

	it('covers leave requests being made, decided and cancelled', async () => {
		await wipe();
		const hook = await endpoint('own', URL_A, ['leave_request.created', 'leave_request.updated']);
		const casual = (
			await withTenant(sys(), (tx) => tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'casual')))
		)[0].id;
		const ask = (startDate: string) =>
			requestLeave(who.staff, { leaveTypeId: casual, startDate, endDate: '', session: 'full', reason: '' });
		const first = await ask(work(addDays(today, 20)));
		await decideLeave(who.boss, first, { decision: 'approve', note: '' });
		const second = await ask(work(addDays(today, 30)));
		await cancelLeave(who.staff, second);
		expect((await deliveriesFor(hook.id)).map((d) => [d.event, d.data.leaveRequestId, d.data.employeeId])).toEqual([
			['leave_request.created', first, ids.staff],
			['leave_request.updated', first, ids.staff],
			['leave_request.created', second, ids.staff],
			['leave_request.updated', second, ids.staff]
		]);
	});
});

describe('delivering', () => {
	it('signs the body, sends only ids and marks it delivered once', async () => {
		await wipe();
		const hook = await endpoint('own', URL_A, ['employee.created']);
		await withTenant(sys(), (tx) =>
			tx.update(webhookEndpoints).set({ failureCount: 3 }).where(eq(webhookEndpoints.id, hook.id))
		);
		const id = await hire(tenant, 'Si Signed', { nationalId: '1990123456789' });
		const [d] = await deliveriesFor(hook.id);
		const { sent, send } = capture(204);
		await deliverWebhook({ tenantId: tenant.id, deliveryId: d.id, attempt: 0 }, send);
		await deliverWebhook({ tenantId: tenant.id, deliveryId: d.id, attempt: 0 }, send);
		expect(sent.length).toBe(1);
		const [req] = sent;
		expect(req.url).toBe(URL_A);
		expect(JSON.parse(req.body)).toEqual({
			id: d.id,
			event: 'employee.created',
			occurredAt: d.createdAt.toISOString(),
			data: { employeeId: id }
		});
		expect(req.body).not.toContain('Si Signed');
		expect(req.headers['x-hrms-event']).toBe('employee.created');
		expect(req.headers['x-hrms-delivery']).toBe(d.id);
		const [, ts, sig] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers['x-hrms-signature'])!;
		expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(60);
		expect(sig).toBe(createHmac('sha256', hook.secret).update(`${ts}.${req.body}`).digest('hex'));
		const [after] = await deliveriesFor(hook.id);
		expect([after.status, after.attempts, after.lastStatus]).toEqual(['delivered', 1, 204]);
		const [ep] = await withTenant(sys(), (tx) =>
			tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, hook.id))
		);
		expect(ep.failureCount).toBe(0);
	});

	it('retries with growing gaps and gives up after eight tries', async () => {
		await wipe();
		const hook = await endpoint('own', URL_A, ['employee.created']);
		await hire(tenant, 'Re Retry');
		const fail = capture(500);
		const [d] = await deliveriesFor(hook.id);
		const before = Date.now();
		await deliverWebhook({ tenantId: tenant.id, deliveryId: d.id, attempt: 0 }, fail.send);
		let [row] = await deliveriesFor(hook.id);
		expect([row.status, row.attempts, row.lastStatus, row.lastError]).toEqual([
			'pending',
			1,
			500,
			'The endpoint answered 500.'
		]);
		const gap = row.nextAttemptAt.getTime() - before;
		expect(gap).toBeGreaterThanOrEqual(59_000);
		expect(gap).toBeLessThan(70_000);
		expect((await queue('webhooks').getJob(`wh-${d.id}-1`))?.opts.delay).toBe(60_000);
		const broken: Sender = async () => {
			throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
		};
		await deliverWebhook({ tenantId: tenant.id, deliveryId: d.id, attempt: 1 }, broken);
		[row] = await deliveriesFor(hook.id);
		expect(row.lastError).toBe('The endpoint could not be reached (ECONNREFUSED).');
		expect(row.lastStatus).toBeNull();
		for (let attempt = 2; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++)
			await deliverWebhook({ tenantId: tenant.id, deliveryId: d.id, attempt }, fail.send);
		[row] = await deliveriesFor(hook.id);
		expect([row.status, row.attempts]).toEqual(['failed', WEBHOOK_MAX_ATTEMPTS]);
		await deliverWebhook({ tenantId: tenant.id, deliveryId: d.id, attempt: WEBHOOK_MAX_ATTEMPTS }, fail.send);
		expect(fail.sent.length).toBe(WEBHOOK_MAX_ATTEMPTS - 1);
	});

	it('turns the endpoint off after fifty failures in a row and tells api managers', async () => {
		await wipe();
		const hook = await endpoint('own', URL_A, ['employee.created']);
		await withTenant(sys(), (tx) =>
			tx
				.update(webhookEndpoints)
				.set({ failureCount: WEBHOOK_DISABLE_AFTER - 2 })
				.where(eq(webhookEndpoints.id, hook.id))
		);
		await hire(tenant, 'Fa One');
		await hire(tenant, 'Fa Two');
		await hire(tenant, 'Fa Three');
		const fail = capture(503);
		await drain(hook.id, fail.send);
		expect(fail.sent.length).toBe(2);
		const [ep] = await withTenant(sys(), (tx) =>
			tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, hook.id))
		);
		expect([ep.active, ep.failureCount, ep.disabledAt !== null]).toEqual([false, WEBHOOK_DISABLE_AFTER, true]);
		const statuses = (await deliveriesFor(hook.id)).map((d) => d.status).sort();
		expect(statuses).toEqual(['failed', 'pending', 'pending']);
		const told = await withTenant(sys(), (tx) =>
			tx
				.select({ membershipId: notifications.membershipId })
				.from(notifications)
				.where(
					and(eq(notifications.category, 'webhooks'), eq(notifications.title, 'A webhook endpoint was turned off'))
				)
		);
		expect(told.map((n) => n.membershipId)).toEqual([who.own.access.membershipId]);
		await hire(tenant, 'Fa Four');
		expect((await deliveriesFor(hook.id)).length).toBe(3);
		await setWebhookActive(who.own, hook.id, true);
		const [back] = await withTenant(sys(), (tx) =>
			tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, hook.id))
		);
		expect([back.active, back.failureCount, back.disabledAt]).toEqual([true, 0, null]);
	});

	it('does not send to an endpoint that was turned off, and uses a rotated secret', async () => {
		await wipe();
		const hook = await endpoint('own', URL_A, ['employee.created']);
		await hire(tenant, 'Of Off');
		await setWebhookActive(who.own, hook.id, false);
		const { sent, send } = capture();
		await drain(hook.id, send);
		expect(sent).toEqual([]);
		const [row] = await deliveriesFor(hook.id);
		expect([row.status, row.lastError]).toEqual(['failed', 'The endpoint is turned off.']);
		await setWebhookActive(who.own, hook.id, true);
		const fresh = await rotateWebhookSecret(who.own, hook.id);
		expect(fresh).not.toBe(hook.secret);
		await hire(tenant, 'Ro Rotated');
		await drain(hook.id, send);
		const [, ts, sig] = /^t=(\d+),v1=(.+)$/.exec(sent[0].headers['x-hrms-signature'])!;
		expect(sig).toBe(createHmac('sha256', fresh).update(`${ts}.${sent[0].body}`).digest('hex'));
	});
});

describe('broken secrets and private details', () => {
	it('fails a delivery whose secret cannot be read, without sending', async () => {
		await wipe();
		const hook = await endpoint('own', URL_A, ['employee.created']);
		await withTenant(sys(), (tx) =>
			tx.update(webhookEndpoints).set({ secretEnc: 'garbage' }).where(eq(webhookEndpoints.id, hook.id))
		);
		await hire(tenant, 'Ga Garbage');
		const { sent, send } = capture();
		await drain(hook.id, send);
		expect(sent).toEqual([]);
		const [row] = await deliveriesFor(hook.id);
		expect([row.status, row.attempts, row.lastError]).toEqual([
			'pending',
			1,
			'The signing secret could not be read. Make a new secret.'
		]);
		const [ep] = await withTenant(sys(), (tx) =>
			tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, hook.id))
		);
		expect(ep.failureCount).toBe(1);
	});

	it('keeps the address path out of the audit log and notifications', async () => {
		await wipe();
		const url = 'https://hooks.example.com/services/T0/B0/SECRETTOKEN';
		const hook = await endpoint('own', url, ['employee.created']);
		await withTenant(sys(), (tx) =>
			tx
				.update(webhookEndpoints)
				.set({ failureCount: WEBHOOK_DISABLE_AFTER - 1 })
				.where(eq(webhookEndpoints.id, hook.id))
		);
		await hire(tenant, 'Le Leak');
		await drain(hook.id, capture(500).send);
		await deleteWebhook(who.own, hook.id);
		const audit = await ownerPool().sql<{ v: unknown }[]>`
			select new_values as v from audit_log where table_name = 'webhook_endpoints' and row_id = ${hook.id} and event is not null`;
		expect(audit.map((a) => a.v)).toEqual([
			{ host: 'hooks.example.com', events: 'employee.created' },
			{ host: 'hooks.example.com' }
		]);
		const told = await withTenant(sys(), (tx) =>
			tx.select({ body: notifications.body }).from(notifications).where(eq(notifications.category, 'webhooks'))
		);
		expect(told.some((n) => n.body?.includes('hooks.example.com failed'))).toBe(true);
		expect(told.some((n) => n.body?.includes('SECRETTOKEN'))).toBe(false);
	});
});

describe('hourly sweep', () => {
	it('queues stuck deliveries again and drops ones older than thirty days', async () => {
		await wipe();
		const hook = await endpoint('own', URL_A, ['employee.created']);
		await hire(tenant, 'St Stuck');
		await hire(tenant, 'Ol Old');
		const [stuck, old] = await deliveriesFor(hook.id);
		await withTenant(sys(), async (tx) => {
			await tx
				.update(webhookDeliveries)
				.set({ attempts: 2, nextAttemptAt: new Date(Date.now() - 3_600_000) })
				.where(eq(webhookDeliveries.id, stuck.id));
			await tx
				.update(webhookDeliveries)
				.set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
				.where(eq(webhookDeliveries.id, old.id));
		});
		await queue('webhooks').remove(`wh-${stuck.id}-2`);
		await runWebhooks();
		expect((await deliveriesFor(hook.id)).map((d) => d.id)).toEqual([stuck.id]);
		expect((await queue('webhooks').getJob(`wh-${stuck.id}-2`))?.data.attempt).toBe(2);
	});
});
