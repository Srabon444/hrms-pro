import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { createSession } from '../../src/lib/server/auth/session';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { memberships } from '../../src/lib/server/db/schema';
import {
	declineRequest,
	feedbackFor,
	feedbackPage,
	forgetFeedback,
	giveFeedback,
	requestFeedback
} from '../../src/lib/server/feedback';
import {
	addItem,
	forgetPrivateNotes,
	meetingPage,
	oneOnOnesHome,
	removeItem,
	savePrivateNote,
	scheduleOneOnOne,
	setMeetingStatus,
	toggleAction
} from '../../src/lib/server/one-on-ones';
import { MODULE_IDS } from '../../src/lib/modules';
import { saveModules } from '../../src/lib/server/modules';
import { createCycle, reviewView } from '../../src/lib/server/performance';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let tenant: Tenant;
let other: Tenant;
const who: Record<string, Member> = {};
const emp: Record<string, string> = {};
const sys = (t = tenant) => systemCtx(t.id);
const sql = () => ownerPool().sql;
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const inT = <T>(m: Member, fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) =>
	withTenant(sys(m.tenant as Tenant), fn);
const mid = (k: string) => who[k].access.membershipId;
const page = (k: string, id: string) => inT(who[k], (tx) => meetingPage(tx, who[k].access, id));

async function member(t: Tenant, key: string, roleKeys: string[], manager: string | null) {
	const u = await createUser();
	await sql()`update users set name = ${`${key} person`} where id = ${u.id}`;
	const [e] = await sql()<{ id: string }[]>`
		insert into employees (tenant_id, code, full_name, employment_type, status, join_date, manager_id)
		values (${t.id}, ${key}, ${`${key} person`}, 'full_time', 'active', '2024-01-01', ${manager}) returning id`;
	emp[key] = e.id;
	const m = await withTenant(sys(t), async (tx) => {
		const id = await addMember(tx, t.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId: e.id }).where(eq(memberships.id, id));
		return id;
	});
	const { token } = await createSession(u.id, {});
	who[key] = {
		user: { userId: u.id, sessionId: sha256(token), totpEnabled: false },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: await loadAccess(t.id, { id: m, status: 'active', employeeId: e.id })
	} as unknown as Member;
}

const notes = (membershipId: string) =>
	sql()<{ title: string; body: string | null }[]>`
		select title, body from notifications where membership_id = ${membershipId}
		and category in ('one_on_ones', 'feedback') order by created_at`;

const BUCKETS = ['one_on_one', 'one_on_one_edit', 'feedback', 'feedback_request'];
const resetLimits = async () =>
	(await redisReady()).del(
		...Object.values(who).flatMap((m) => BUCKETS.map((b) => rkey('rl', b, m.access.membershipId)))
	);

beforeAll(async () => {
	tenant = await createTenant('ooo');
	other = await createTenant('ooob');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(sys(other), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	await member(tenant, 'hr', ['hr_admin'], null);
	await member(tenant, 'mgr', ['line_manager'], null);
	await member(tenant, 'emp', [], emp.mgr);
	await member(tenant, 'peer', [], emp.mgr);
	await member(tenant, 'out', [], null);
	await member(tenant, 'boss', ['line_manager'], null);
	await member(other, 'olga', ['owner'], null);
	await resetLimits();
});

afterAll(async () => {
	await resetLimits();
	await closeRedis();
	await closePools();
});

describe('1:1s', () => {
	let first: string;
	let second: string;

	it('is scheduled only between an employee and their manager', async () => {
		first = await scheduleOneOnOne(who.emp, { employeeId: emp.emp, scheduledFor: '2026-11-02' });
		expect(await notes(mid('mgr'))).toEqual([
			{ title: 'emp person scheduled a 1:1 with you on 2026-11-02', body: null }
		]);
		second = await scheduleOneOnOne(who.mgr, { employeeId: emp.emp, scheduledFor: '2026-11-16' });
		expect((await page('emp', second))?.meeting).toMatchObject({
			managerName: 'mgr person',
			employeeName: 'emp person'
		});
		expect(await code(scheduleOneOnOne(who.peer, { employeeId: emp.emp, scheduledFor: '2026-11-02' }))).toBe(
			'invalid_person'
		);
		expect(await code(scheduleOneOnOne(who.out, { employeeId: emp.out, scheduledFor: '2026-11-02' }))).toBe(
			'no_manager'
		);
		expect(await code(scheduleOneOnOne(who.mgr, { employeeId: emp.olga, scheduledFor: '2026-11-02' }))).toBe(
			'invalid_person'
		);
		expect(await code(scheduleOneOnOne(who.emp, { employeeId: emp.emp, scheduledFor: '0000-01-01' }))).toBe(
			'invalid: Choose a date.'
		);
		expect(await code(scheduleOneOnOne(who.emp, { employeeId: emp.emp, scheduledFor: '2026-02-30' }))).toBe(
			'invalid: Choose a date.'
		);
		const home = await inT(who.mgr, (tx) => oneOnOnesHome(tx, who.mgr.access));
		expect(home.mine.map((r) => r.id).sort()).toEqual([first, second].sort());
		expect(home.reports.map((r) => r.name)).toEqual(['emp person', 'peer person']);
		expect((await inT(who.emp, (tx) => oneOnOnesHome(tx, who.emp.access))).myManager?.name).toBe('mgr person');
	});

	it('is visible to the two people and HR only', async () => {
		expect(await page('out', first)).toBeNull();
		expect(await page('peer', first)).toBeNull();
		expect(await withTenant(sys(other), (tx) => meetingPage(tx, who.olga.access, first))).toBeNull();
		const hr = await page('hr', first);
		expect([hr?.participant, hr?.canEdit, hr?.privateNote]).toEqual([false, false, null]);
		const home = await inT(who.hr, (tx) => oneOnOnesHome(tx, who.hr.access));
		expect(home.others.map((r) => r.id)).toContain(first);
	});

	it('keeps shared agenda and actions, and carries open actions to the next 1:1', async () => {
		await addItem(who.emp, first, { kind: 'agenda', text: 'Career plan' });
		await addItem(who.mgr, first, { kind: 'action', text: 'Book the course', ownerEmployeeId: emp.emp });
		expect(await code(addItem(who.mgr, first, { kind: 'action', text: 'x', ownerEmployeeId: emp.out }))).toBe(
			'invalid_owner'
		);
		expect(await code(addItem(who.hr, first, { kind: 'agenda', text: 'x' }))).toBe('forbidden');
		expect(await code(addItem(who.out, first, { kind: 'agenda', text: 'x' }))).toBe('not_found');
		expect(await code(addItem(who.emp, first, { kind: 'agenda', text: 'a\0b' }))).toBe(
			'invalid: Remove unsupported characters.'
		);
		const one = await page('mgr', first);
		expect(one?.items.map((i) => [i.kind, i.text, i.owner, i.done])).toEqual([
			['agenda', 'Career plan', '', false],
			['action', 'Book the course', 'emp person', false]
		]);
		expect((await page('hr', first))?.items).toHaveLength(2);
		const two = await page('emp', second);
		expect(two?.carried).toEqual([expect.objectContaining({ text: 'Book the course', from: '2026-11-02' })]);
		const action = one!.items[1].id;
		expect(await code(toggleAction(who.out, action))).toBe('not_found');
		expect(await code(toggleAction(who.emp, one!.items[0].id))).toBe('not_action');
		await toggleAction(who.emp, action);
		expect((await page('emp', second))?.carried).toEqual([]);
		expect((await page('emp', first))?.items[1].done).toBe(true);
		expect(await code(removeItem(who.hr, one!.items[0].id))).toBe('forbidden');
		await removeItem(who.emp, one!.items[0].id);
		expect((await page('emp', first))?.items).toHaveLength(1);
	});

	it('keeps private notes readable only by their author', async () => {
		await savePrivateNote(who.emp, first, 'I want a raise');
		await savePrivateNote(who.mgr, first, 'Strong year');
		expect((await page('emp', first))?.privateNote).toBe('I want a raise');
		expect((await page('mgr', first))?.privateNote).toBe('Strong year');
		expect((await page('hr', first))?.privateNote).toBeNull();
		expect(await code(savePrivateNote(who.hr, first, 'peek'))).toBe('forbidden');
		const [{ n }] = await sql()<{ n: number }[]>`
			select count(*)::int as n from audit_log where table_name = 'one_on_one_private_notes'`;
		expect(n).toBe(0);
		await savePrivateNote(who.emp, first, '  ');
		expect((await page('emp', first))?.privateNote).toBe('');
		expect((await page('mgr', first))?.privateNote).toBe('Strong year');
	});

	it('closes once and refuses new items after a cancel', async () => {
		await setMeetingStatus(who.mgr, first, 'done');
		expect(await code(setMeetingStatus(who.emp, first, 'cancelled'))).toBe('not_scheduled');
		expect(await code(setMeetingStatus(who.hr, second, 'cancelled'))).toBe('forbidden');
		await setMeetingStatus(who.emp, second, 'cancelled');
		expect(await code(addItem(who.emp, second, { kind: 'agenda', text: 'late' }))).toBe('cancelled');
		expect((await page('emp', second))?.canEdit).toBe(false);
	});

	it('follows the current manager, who inherits the open actions', async () => {
		await addItem(who.emp, first, { kind: 'action', text: 'Write the plan', ownerEmployeeId: emp.emp });
		await sql()`update employees set manager_id = ${emp.boss} where id = ${emp.emp}`;
		try {
			expect(await page('mgr', first)).toBeNull();
			expect(await code(addItem(who.mgr, first, { kind: 'agenda', text: 'x' }))).toBe('not_found');
			expect((await page('boss', first))?.participant).toBe(true);
			const next = await scheduleOneOnOne(who.boss, { employeeId: emp.emp, scheduledFor: '2026-12-01' });
			expect((await page('boss', next))?.carried.map((c) => c.text)).toEqual(['Write the plan']);
			const mine = (await inT(who.mgr, (tx) => oneOnOnesHome(tx, who.mgr.access))).mine.map((r) => r.id);
			expect(mine).not.toContain(first);
		} finally {
			await sql()`update employees set manager_id = ${emp.mgr} where id = ${emp.emp}`;
		}
	});
});

describe('feedback', () => {
	it('shares feedback with its subject only when the giver chose to', async () => {
		await giveFeedback(who.peer, { toEmployeeId: emp.emp, text: 'Great demo', visibility: 'shared' });
		await giveFeedback(who.out, { toEmployeeId: emp.emp, text: 'Misses deadlines', visibility: 'manager_only' });
		const titles = (await notes(mid('emp'))).map((n) => n.title);
		expect(titles.filter((t) => t.includes('gave you feedback'))).toEqual(['peer person gave you feedback']);
		expect(JSON.stringify(await notes(mid('emp')))).not.toContain('Great demo');
		const mine = await inT(who.emp, (tx) => feedbackPage(tx, who.emp.access));
		expect(mine.received.map((f) => [f.from, f.text])).toEqual([['peer person', 'Great demo']]);
		const given = await inT(who.out, (tx) => feedbackPage(tx, who.out.access));
		expect(given.given).toEqual([expect.objectContaining({ to: 'emp person', visibility: 'manager_only' })]);
		const period = ['2000-01-01', '2100-01-01'] as const;
		const view = (k: string) => inT(who[k], (tx) => feedbackFor(tx, who[k].access, emp.emp, ...period));
		expect((await view('emp')).map((f) => f.text)).toEqual(['Great demo']);
		expect((await view('mgr')).map((f) => f.text).sort()).toEqual(['Great demo', 'Misses deadlines']);
		expect((await view('hr')).map((f) => f.text).sort()).toEqual(['Great demo', 'Misses deadlines']);
		expect(await view('peer')).toEqual([]);
		const [{ n }] = await sql()<{ n: number }[]>`
			select count(*)::int as n from audit_sensitive s join audit_log l on l.id = s.audit_id
			where l.table_name in ('feedback', 'feedback_requests', 'one_on_one_items', 'one_on_one_private_notes')`;
		expect(n).toBe(0);
		expect(await inT(who.mgr, (tx) => feedbackFor(tx, who.mgr.access, emp.emp, '2000-01-01', '2000-12-31'))).toEqual(
			[]
		);
		expect(await code(giveFeedback(who.emp, { toEmployeeId: emp.emp, text: 'me', visibility: 'shared' }))).toBe('self');
		expect(await code(giveFeedback(who.emp, { toEmployeeId: emp.olga, text: 'x', visibility: 'shared' }))).toBe(
			'invalid_person'
		);
		expect(await code(giveFeedback(who.emp, { toEmployeeId: emp.peer, text: 'x', visibility: 'public' }))).toBe(
			'invalid: Choose who can read it.'
		);
	});

	it('answers and declines requests only by the person asked', async () => {
		await requestFeedback(who.emp, { askedMembershipId: mid('peer'), note: 'How was my demo?' });
		expect(await code(requestFeedback(who.emp, { askedMembershipId: mid('peer') }))).toBe('already_asked');
		expect(await code(requestFeedback(who.emp, { askedMembershipId: mid('emp') }))).toBe('self');
		expect(await code(requestFeedback(who.emp, { askedMembershipId: mid('olga') }))).toBe('invalid_person');
		const [req] = (await inT(who.peer, (tx) => feedbackPage(tx, who.peer.access))).waiting;
		expect(req).toMatchObject({ requester: 'emp person', note: 'How was my demo?', aboutEmployeeId: emp.emp });
		expect(
			await code(giveFeedback(who.out, { toEmployeeId: emp.emp, text: 'x', visibility: 'shared', requestId: req.id }))
		).toBe('not_found');
		expect(
			await code(giveFeedback(who.peer, { toEmployeeId: emp.mgr, text: 'x', visibility: 'shared', requestId: req.id }))
		).toBe('not_found');
		await giveFeedback(who.peer, {
			toEmployeeId: emp.emp,
			text: 'Clear slides',
			visibility: 'shared',
			requestId: req.id
		});
		expect((await notes(mid('emp'))).map((n) => n.title)).toContain('peer person answered your feedback request');
		expect(
			await code(
				giveFeedback(who.peer, { toEmployeeId: emp.emp, text: 'again', visibility: 'shared', requestId: req.id })
			)
		).toBe('not_found');
		await requestFeedback(who.emp, { askedMembershipId: mid('out') });
		const [r2] = (await inT(who.out, (tx) => feedbackPage(tx, who.out.access))).waiting;
		expect(await code(declineRequest(who.peer, r2.id))).toBe('not_found');
		await declineRequest(who.out, r2.id);
		const asked = (await inT(who.emp, (tx) => feedbackPage(tx, who.emp.access))).asked;
		expect(asked.map((a) => [a.asked, a.status]).sort()).toEqual([
			['out person', 'declined'],
			['peer person', 'answered']
		]);
	});

	it('shows period feedback in the review only when the module is on', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const { cycleId } = await createCycle(who.hr, { name: 'H2', periodStart: '2026-01-01', periodEnd: today });
		const [{ id }] = await sql()<{ id: string }[]>`
			select id from reviews where cycle_id = ${cycleId} and employee_id = ${emp.emp}`;
		const sidebar = async (k: string) =>
			(await inT(who[k], (tx) => reviewView(tx, who[k].access, id)))?.feedback.map((f) => f.text).sort();
		expect(await sidebar('mgr')).toEqual([]);
		await saveModules(sys(), [...MODULE_IDS]);
		expect(await sidebar('mgr')).toEqual(['Clear slides', 'Great demo', 'Misses deadlines']);
		expect(await sidebar('emp')).toEqual(['Clear slides', 'Great demo']);
	});

	it('limits feedback to 30 a day', async () => {
		await resetLimits();
		for (let i = 0; i < 30; i++)
			await giveFeedback(who.mgr, { toEmployeeId: emp.peer, text: `n${i}`, visibility: 'manager_only' });
		expect(await code(giveFeedback(who.mgr, { toEmployeeId: emp.peer, text: 'more', visibility: 'shared' }))).toBe(
			'too_many'
		);
	});

	it('refuses members who have left', async () => {
		await sql()`update memberships set status = 'ex_employee' where id = ${mid('out')}`;
		expect(await code(giveFeedback(who.out, { toEmployeeId: emp.emp, text: 'bye', visibility: 'shared' }))).toBe(
			'forbidden'
		);
		await sql()`update memberships set status = 'active' where id = ${mid('out')}`;
	});
});

describe('retention', () => {
	it('removes a leaver’s private notes and requests and anonymises their feedback', async () => {
		await resetLimits();
		const m = await scheduleOneOnOne(who.peer, { employeeId: emp.peer, scheduledFor: '2026-11-20' });
		await giveFeedback(who.emp, { toEmployeeId: emp.peer, text: 'About peer', visibility: 'shared' });
		await savePrivateNote(who.peer, m, 'Thinking of leaving');
		await requestFeedback(who.peer, { askedMembershipId: mid('emp') });
		await withTenant(sys(), async (tx) => {
			await forgetPrivateNotes(tx, [mid('peer')]);
			await forgetFeedback(tx, [mid('peer')]);
		});
		const [{ n }] = await sql()<{ n: number }[]>`
			select count(*)::int as n from one_on_one_private_notes where author_membership_id = ${mid('peer')}`;
		expect(n).toBe(0);
		const page = await inT(who.emp, (tx) => feedbackPage(tx, who.emp.access));
		expect(page.received.map((f) => f.from)).toEqual(['Former employee', 'Former employee']);
		expect(page.waiting).toEqual([]);
		expect(page.asked.map((a) => a.asked)).toEqual(['out person']);
		const [{ about }] = await sql()<{ about: number }[]>`
			select count(*)::int as about from feedback where to_employee_id = ${emp.peer}`;
		expect(about).toBe(0);
	});
});
