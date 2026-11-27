import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODULE_IDS, MODULES } from '../../src/lib/modules';
import { createApiKey, revokeApiKey } from '../../src/lib/server/api-keys';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { hashPassword } from '../../src/lib/server/auth/password';
import { changePassword, confirmRecentAuth } from '../../src/lib/server/auth/service';
import { createSession } from '../../src/lib/server/auth/session';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { apiKeys, employees, memberships, rolePermissions, roles } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { saveModules } from '../../src/lib/server/modules';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { API_AUTH_FAILS_PER_IP_HOUR, API_PER_KEY_MIN, apiRequest } from '../../src/lib/server/public/api';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let tenant: Tenant;
let other: Tenant;
const ids: Record<string, string> = {};
const mids: Record<string, string> = {};
const who: Record<string, Member> = {};
const PASSWORD = 'correct horse battery staple 42';
const IP = '203.0.113.50';
const sys = (t = tenant) => systemCtx(t.id);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const hr = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.sensitive.update': ['all'] }
};
const NOW = '2026-11-24T09:00:00+06:00';
const at = <T>(iso: string, fn: () => Promise<T>) => withTestNow(iso, fn);

async function member(t: Tenant, key: string, roleKeys: string[], extra: Record<string, string> = {}) {
	const employeeId = await createEmployee(
		{ tenantId: t.id, actor: 'user' },
		{ ...hr, roleKeys: [], isOwner: false } as never,
		{
			...blanks,
			fullName: `${key} person`,
			employmentType: 'full_time',
			status: 'active',
			joinDate: '2026-01-01',
			nationalId: '1990123456789',
			...extra
		}
	);
	const u = await createUser();
	await ownerPool().sql`update users set password_hash = ${await hashPassword(PASSWORD)} where id = ${u.id}`;
	const id = await withTenant(sys(t), async (tx) => {
		const membershipId = await addMember(tx, t.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	const { token } = await createSession(u.id, {});
	ids[key] = employeeId;
	mids[key] = id;
	who[key] = {
		user: { userId: u.id, sessionId: sha256(token), totpEnabled: false },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: await loadAccess(t.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const refresh = async (key: string) => {
	who[key] = {
		...who[key],
		access: await loadAccess(who[key].tenant.id, { id: mids[key], status: 'active', employeeId: ids[key] })
	};
};

async function call(key: string, path: string, init: RequestInit = {}, ip = IP) {
	const res = await apiRequest(
		new Request(`http://localhost/api/v1/${path}`, {
			...init,
			headers: { authorization: `Bearer ${key}`, ...init.headers }
		}),
		path.split('?')[0],
		ip
	);
	return {
		status: res.status,
		body: (await res.json()) as { data?: unknown; nextCursor?: string | null; error?: string }
	};
}

async function newKey(key: string, raw: Record<string, string>) {
	await confirmRecentAuth(who[key].user, PASSWORD, '');
	return createApiKey(who[key], { days: '90', ...raw });
}

const listed = (body: { data?: unknown }) => (body.data as { id: string }[]).map((r) => r.id).sort();

beforeAll(async () => {
	tenant = await createTenant('api');
	other = await createTenant('apib');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(sys(other), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	await withTenant(sys(), async (tx) => {
		const [role] = await tx
			.insert(roles)
			.values({ tenantId: tenant.id, key: 'api_lead', name: 'API lead' })
			.returning();
		await tx.insert(rolePermissions).values(
			[
				['api.manage', 'all'],
				['employee.read', 'team'],
				['attendance.read', 'team'],
				['leave.read', 'team']
			].map(([permission, scope]) => ({ tenantId: tenant.id, roleId: role.id, permission, scope }))
		);
	});
	await member(tenant, 'own', ['owner']);
	await member(tenant, 'lead', ['api_lead']);
	await member(tenant, 'tia', ['employee']);
	await member(tenant, 'uma', ['employee']);
	await member(other, 'olga', ['owner']);
	await withTenant(sys(), (tx) => tx.update(employees).set({ managerId: ids.lead }).where(eq(employees.id, ids.tia)));
	const r = await redisReady();
	await r.del(rkey('rl', 'api-auth-fail', IP), ...Object.values(who).map((m) => rkey('rl', 'reauth', m.user.userId)));
});

afterAll(async () => {
	await closeRedis();
	await closePools();
});

describe('making API keys', () => {
	it('needs a fresh password confirmation that lasts ten minutes', async () => {
		await at(NOW, async () => {
			expect(await code(createApiKey(who.lead, { name: 'Early', days: '90', 'grant.employee.read': 'team' }))).toBe(
				'reauth_required'
			);
			expect(await code(confirmRecentAuth(who.lead.user, 'wrong password', ''))).toBe('wrong_password');
			await confirmRecentAuth(who.lead.user, PASSWORD, '');
			expect(await code(createApiKey(who.lead, { name: 'Early', days: '90', 'grant.employee.read': 'team' }))).toBe(
				'ok'
			);
		});
		expect(
			await code(
				at('2026-11-24T09:11:00+06:00', () =>
					createApiKey(who.lead, { name: 'Late', days: '90', 'grant.employee.read': 'team' })
				)
			)
		).toBe('reauth_required');
		const r = await redisReady();
		await r.del(rkey('rl', 'reauth', who.uma.user.userId));
		const tries = [];
		for (let i = 0; i < 6; i++) tries.push(await code(confirmRecentAuth(who.uma.user, 'nope', '')));
		expect(tries.slice(0, 5).every((t) => t === 'wrong_password')).toBe(true);
		expect(tries[5]).toBe('rate_limited');
	});

	it('only grants what the creator can read, for a year at most, and stores only the hash', async () => {
		await at(NOW, async () => {
			await confirmRecentAuth(who.tia.user, PASSWORD, '');
			expect(await code(createApiKey(who.tia, { name: 'Mine', days: '90', 'grant.employee.read': 'own' }))).toBe(
				'forbidden'
			);
			expect(await code(newKey('lead', { name: 'Wide', 'grant.employee.read': 'all' }))).toBe('forbidden');
			expect(await code(newKey('lead', { name: 'Pay', 'grant.payroll.read': 'all' }))).toBe('invalid');
			expect(await code(newKey('lead', { name: 'None' }))).toBe('invalid');
			expect(await code(newKey('lead', { name: 'Long', days: '400', 'grant.employee.read': 'team' }))).toBe('invalid');
			expect(await code(newKey('lead', { name: 'Early', 'grant.employee.read': 'team' }))).toBe('duplicate');
			const key = await newKey('lead', { name: 'Sync', 'grant.employee.read': 'team', 'grant.leave.read': 'own' });
			expect(key).toMatch(/^hrp_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
			const [row] = await ownerPool().sql<{ key_hash: string; grants: unknown; expires_at: Date; created_at: Date }[]>`
				select key_hash, grants, expires_at, created_at from api_keys where tenant_id = ${tenant.id} and name = 'Sync'`;
			expect(row.key_hash).toBe(sha256(key));
			expect(JSON.stringify(row)).not.toContain(key.split('_')[2]);
			expect(row.grants).toEqual({ 'employee.read': 'team', 'leave.read': 'own' });
			expect(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()).toBe(90 * 86_400_000);
			const [audit] = await ownerPool().sql`
				select 1 from audit_log where tenant_id = ${tenant.id} and event = 'api_key.create'`;
			expect(audit).toBeTruthy();
		});
	});
});

describe('the REST API', () => {
	let lead: string;
	let owner: string;
	beforeAll(async () => {
		lead = await at(NOW, () =>
			newKey('lead', { name: 'Team reader', 'grant.employee.read': 'team', 'grant.attendance.read': 'team' })
		);
		owner = await at(NOW, () =>
			newKey('own', {
				name: 'Everything',
				'grant.employee.read': 'all',
				'grant.calendar.read': 'all',
				'grant.schedule.read': 'all'
			})
		);
		await ownerPool().sql`
			insert into attendance_days (tenant_id, employee_id, date, status)
			values (${tenant.id}, ${ids.tia}, '2026-11-20', 'present'), (${tenant.id}, ${ids.uma}, '2026-11-20', 'present')`;
	});

	it('reads only the key scope, through a short field list, one page at a time', async () => {
		const all = await call(lead, 'employees');
		expect(all.status).toBe(200);
		expect(listed(all.body)).toEqual([ids.lead, ids.tia].sort());
		const row = (all.body.data as Record<string, unknown>[])[0];
		expect(Object.keys(row).sort()).toEqual(
			[
				'branchId',
				'code',
				'department',
				'designation',
				'employmentType',
				'exitDate',
				'fullName',
				'id',
				'joinDate',
				'managerId',
				'status',
				'workEmail'
			].sort()
		);
		expect(JSON.stringify(all.body)).not.toContain('1990123456789');
		const first = await call(lead, 'employees?limit=1');
		expect(first.body.nextCursor).toBeTruthy();
		const second = await call(lead, `employees?limit=1&cursor=${first.body.nextCursor}`);
		expect([...listed(first.body), ...listed(second.body)].sort()).toEqual(listed(all.body));
		expect(second.body.nextCursor).toBeNull();
		expect((await call(lead, `employees/${ids.uma}`)).status).toBe(404);
		expect((await call(lead, `employees/${ids.tia}`)).status).toBe(200);
		const days = await call(lead, 'attendance-days?from=2026-11-01&to=2026-11-30');
		expect((days.body.data as { employeeId: string }[]).map((d) => d.employeeId)).toEqual([ids.tia]);
		expect((await call(owner, 'employees?limit=200')).body.data).toHaveLength(4);
	});

	it('refuses bad requests with JSON errors', async () => {
		expect((await call(lead, 'leave-requests?from=2026-11-01&to=2026-11-30')).status).toBe(403);
		expect((await call(lead, 'attendance-days?from=2026-11-01')).status).toBe(400);
		expect((await call(lead, 'attendance-days?from=2026-01-01&to=2027-06-01')).status).toBe(400);
		expect((await call(lead, 'employees?limit=500')).status).toBe(400);
		expect((await call(lead, 'employees?cursor=nope')).status).toBe(400);
		expect((await call(lead, 'payslips')).status).toBe(404);
		expect(
			(await call(lead, 'employees', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))
				.status
		).toBe(405);
		expect((await call(lead, 'employees', { headers: { 'content-type': 'text/plain' } })).status).toBe(415);
		const doc = await apiRequest(new Request('http://localhost/api/v1/openapi.json'), 'openapi.json', IP);
		expect(doc.status).toBe(200);
		expect(((await doc.json()) as { openapi: string }).openapi).toBe('3.1.0');
	});

	it('follows the creator: a demoted creator narrows the key and a disabled one stops it', async () => {
		const [role] = await withTenant(sys(), (tx) =>
			tx.select({ id: roles.id }).from(roles).where(eq(roles.key, 'api_lead'))
		);
		await withTenant(sys(), (tx) =>
			tx
				.update(rolePermissions)
				.set({ scope: 'own' })
				.where(and(eq(rolePermissions.roleId, role.id), eq(rolePermissions.permission, 'employee.read')))
		);
		expect(listed((await call(lead, 'employees')).body)).toEqual([ids.lead]);
		await withTenant(sys(), (tx) =>
			tx
				.delete(rolePermissions)
				.where(and(eq(rolePermissions.roleId, role.id), eq(rolePermissions.permission, 'attendance.read')))
		);
		expect((await call(lead, 'attendance-days?from=2026-11-01&to=2026-11-30')).body.data).toEqual([]);
		await withTenant(sys(), (tx) =>
			tx.update(memberships).set({ status: 'disabled' }).where(eq(memberships.id, mids.lead))
		);
		expect((await call(lead, 'employees')).status).toBe(401);
		await withTenant(sys(), (tx) =>
			tx.update(memberships).set({ status: 'active' }).where(eq(memberships.id, mids.lead))
		);
		await withTenant(sys(), (tx) =>
			tx
				.update(rolePermissions)
				.set({ scope: 'team' })
				.where(and(eq(rolePermissions.roleId, role.id), eq(rolePermissions.permission, 'employee.read')))
		);
		await refresh('lead');
	});

	it('keeps tenants apart, honours module switches, revocation and expiry', async () => {
		const olga = await at(NOW, () => newKey('olga', { name: 'Other', 'grant.employee.read': 'all' }));
		expect(listed((await call(olga, 'employees')).body)).toEqual([ids.olga]);
		expect((await call(olga, `employees/${ids.tia}`)).status).toBe(404);
		expect((await call(owner, 'events?from=2026-11-01&to=2026-11-30')).status).toBe(200);
		expect((await call(owner, 'roster?from=2026-11-01&to=2026-11-30')).status).toBe(200);
		await saveModules(
			sys(),
			MODULE_IDS.filter((id) => MODULES[id].on && id !== 'events')
		);
		expect((await call(owner, 'events?from=2026-11-01&to=2026-11-30')).status).toBe(404);
		await saveModules(
			sys(),
			MODULE_IDS.filter((id) => MODULES[id].on)
		);
		await ownerPool()
			.sql`update api_keys set expires_at = now() - interval '1 second' where key_hash = ${sha256(olga)}`;
		expect((await call(olga, 'employees')).status).toBe(401);
		const [k] = await withTenant(sys(), (tx) =>
			tx
				.select({ id: apiKeys.id })
				.from(apiKeys)
				.where(eq(apiKeys.keyHash, sha256(owner)))
		);
		await revokeApiKey({ tenantId: tenant.id, actor: 'user', userId: who.own.user.userId }, k.id);
		expect((await call(owner, 'employees')).status).toBe(401);
		expect(await code(revokeApiKey({ tenantId: other.id, actor: 'user' }, k.id))).toBe('not_found');
		const events = await ownerPool().sql<{ event: string }[]>`
			select event from audit_log where tenant_id = ${tenant.id} and row_id = ${k.id} and event like 'api_key.%' order by event`;
		expect(events.map((e) => e.event)).toEqual(['api_key.create', 'api_key.revoke', 'api_key.used']);
	});

	it('rate limits each key and each address that keeps sending bad keys', async () => {
		const [k] = await withTenant(sys(), (tx) =>
			tx
				.select({ id: apiKeys.id })
				.from(apiKeys)
				.where(eq(apiKeys.keyHash, sha256(lead)))
		);
		const r = await redisReady();
		await r.set(rkey('rl', 'api-key', k.id), String(API_PER_KEY_MIN), 'PX', 60_000);
		expect((await call(lead, 'employees')).status).toBe(429);
		await r.del(rkey('rl', 'api-key', k.id));
		const ip = '203.0.113.51';
		await r.del(rkey('rl', 'api-auth-fail', ip));
		for (let i = 0; i < API_AUTH_FAILS_PER_IP_HOUR; i++)
			expect((await call(`hrp_00000000_${'a'.repeat(43)}`, 'employees', {}, ip)).status).toBe(401);
		expect((await call(lead, 'employees', {}, ip)).status).toBe(429);
		expect((await call(lead, 'employees')).status).toBe(200);
	});

	it('records the first use of the day even when that request fails, and only once', async () => {
		const key = await at(NOW, () => newKey('own', { name: 'Fresh', 'grant.employee.read': 'all' }));
		const bad = await call(key, 'employees?limit=99999999999999999999');
		expect(bad.status).toBe(400);
		expect((bad.body as { message: string }).message).toBe('limit must be a whole number from 1 to 200.');
		await call(key, 'employees');
		await call(key, 'employees');
		const [row] = await ownerPool().sql<{ id: string; last_used_at: Date | null }[]>`
			select id, last_used_at from api_keys where key_hash = ${sha256(key)}`;
		expect(row.last_used_at).not.toBeNull();
		const rows = await ownerPool().sql<{ event: string | null; op: string }[]>`
			select event, op from audit_log where tenant_id = ${tenant.id} and row_id = ${row.id} and op = 'UPDATE'`;
		expect(rows).toHaveLength(1);
		const used = await ownerPool().sql`
			select 1 from audit_log where tenant_id = ${tenant.id} and row_id = ${row.id} and event = 'api_key.used'`;
		expect(used).toHaveLength(1);
	});

	it('refuses control characters in a name and revokes the keys of someone who changes their password', async () => {
		expect(await code(at(NOW, () => newKey('lead', { name: 'a\u0000b', 'grant.employee.read': 'own' })))).toBe(
			'invalid'
		);
		const key = await at(NOW, () => newKey('lead', { name: 'Mine', 'grant.employee.read': 'own' }));
		expect((await call(key, 'employees')).status).toBe(200);
		await changePassword(who.lead.user.userId, PASSWORD, 'a brand new long passphrase 77', { ip: IP });
		expect((await call(key, 'employees')).status).toBe(401);
	});
});
