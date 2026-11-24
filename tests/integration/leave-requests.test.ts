import { and, eq, gt, lt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendingApprovals } from '../../src/lib/server/approvals';
import { addFiles, listFiles, openFile, removeFile } from '../../src/lib/server/attachments';
import { closePools } from '../../src/lib/server/db';
import {
	attendanceDays,
	departments,
	employees,
	holidays,
	leaveLedger,
	leaveRequestDays,
	leaveRequests,
	leaveTypes,
	memberships,
	notifications,
	tenantSettings
} from '../../src/lib/server/db/schema';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { ownBalances } from '../../src/lib/server/leave';
import { fiscalYearRange } from '../../src/lib/server/leave-days';
import {
	cancelLeave,
	decideLeave,
	getLeaveRequest,
	myLeave,
	requestLeave,
	whoIsOut
} from '../../src/lib/server/leave-requests';
import { addHoliday, importHolidays } from '../../src/lib/server/org';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const type: Record<string, string> = {};
const who: Record<string, Member> = {};
const today = dateIn(new Date(), 'Asia/Dhaka');
const month = Number(today.slice(5, 7));
const year = fiscalYearRange(Number(today.slice(0, 4)), month);
const sys = () => systemCtx(tenant.id);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (fullName: string, extra: Record<string, string> = {}) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		gender: 'male',
		joinDate: addDays(today, -400),
		...extra
	});

const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const work = (from: string) => {
	let d = from;
	while (weekday(d) === 5 || weekday(d) === 6) d = addDays(d, 1);
	return d;
};
const workAfter = (d: string, n: number) => {
	let out = work(d);
	for (let i = 0; i < n; i++) out = work(addDays(out, 1));
	return out;
};
const friday = (from: string) => {
	let d = from;
	while (weekday(d) !== 5) d = addDays(d, 1);
	return d;
};
const D = work(addDays(today, 14));

async function member(key: string, roleKeys: string[], employeeId: string | null) {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const ask = (key: string, extra: Record<string, string> = {}) =>
	requestLeave(who[key], {
		leaveTypeId: type.casual,
		startDate: D,
		endDate: '',
		session: 'full',
		reason: '',
		...extra
	});
const latest = async (employee: string) =>
	(
		await withTenant(sys(), (tx) => tx.select().from(leaveRequests).where(eq(leaveRequests.employeeId, ids[employee])))
	).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
const balance = async (key: string, name: string) => {
	const { rows } = await withTenant(sys(), (tx) => ownBalances(tx, who[key].access));
	const b = rows.find((r) => r.name === name)!;
	return [b.balance, b.pending, b.available];
};
const inbox = async (key: string) =>
	(await withTenant(sys(), (tx) => pendingApprovals(tx, who[key].access)))
		.filter((i) => i.kind === 'Leave')
		.map((i) => i.title);
const told = async (key: string) =>
	(
		await withTenant(sys(), (tx) =>
			tx
				.select({ title: notifications.title })
				.from(notifications)
				.where(eq(notifications.membershipId, who[key].access.membershipId))
		)
	).map((n) => n.title);
const taken = async (requestId: string) =>
	(
		await withTenant(sys(), (tx) =>
			tx
				.select({ days: leaveLedger.days })
				.from(leaveLedger)
				.where(and(eq(leaveLedger.refId, requestId), eq(leaveLedger.kind, 'taken')))
		)
	)
		.map((r) => r.days)
		.sort((a, b) => a - b);
const decide = (key: string, id: string, decision = 'approve') => decideLeave(who[key], id, { decision, note: '' });
const custodian = () =>
	({ ...who.payroll, access: { ...who.payroll.access, grants: { 'leave.manage': ['all'] } } }) as unknown as Member;
const view = (key: string, id: string) => withTenant(sys(), (tx) => getLeaveRequest(tx, who[key].access, id));

beforeAll(async () => {
	tenant = await createTenant('leavereq');
	await withTenant(sys(), async (tx) => {
		await seedTenant(tx, tenant.id);
		await tx.update(tenantSettings).set({ fiscalYearStartMonth: month });
		await tx.update(leaveTypes).set({ maxConsecutive: 3 }).where(eq(leaveTypes.code, 'casual'));
		await tx.update(leaveTypes).set({ halfDayAllowed: false }).where(eq(leaveTypes.code, 'sick'));
		await tx
			.insert(leaveTypes)
			.values({ tenantId: tenant.id, code: 'old', name: 'Old leave', quota: 5, active: false });
		for (const t of await tx.select().from(leaveTypes)) type[t.code] = t.id;
	});
	ids.big = await hire('Bi Big');
	ids.boss = await hire('Bo Boss', { managerId: ids.big });
	ids.hrEmp = await hire('Ha HR');
	ids.head = await hire('Hd Head');
	ids.staff = await hire('Sam Staff', { managerId: ids.boss });
	ids.peer = await hire('Pe Peer', { managerId: ids.boss });
	ids.orphan = await hire('Or Orphan');
	ids.loner = await hire('Lo Loner');
	ids.stranger = await hire('St Stranger');
	ids.joiner = await hire('Jo Joiner', { status: 'onboarding', joinDate: addDays(today, 20) });
	ids.leaver = await hire('Le Leaver');
	ids.probie = await hire('Pr Probie', { status: 'probation' });
	ids.soon = await hire('So Soon', { probationEndDate: D });
	ids.kid = await hire('Ki Kid', { managerId: ids.peer });
	await withTenant(sys(), async (tx) => {
		const [dept] = await tx
			.insert(departments)
			.values({ tenantId: tenant.id, name: 'Ops', headEmployeeId: ids.head })
			.returning({ id: departments.id });
		await tx.update(employees).set({ departmentId: dept.id }).where(eq(employees.id, ids.orphan));
		await tx.update(employees).set({ departmentId: dept.id }).where(eq(employees.id, ids.head));
		await tx.update(employees).set({ departmentId: dept.id }).where(eq(employees.id, ids.stranger));
		await tx.update(employees).set({ status: 'notice', exitDate: D }).where(eq(employees.id, ids.leaver));
	});
	await member('big', ['line_manager'], ids.big);
	await member('boss', ['line_manager'], ids.boss);
	await member('hr', ['hr_admin'], ids.hrEmp);
	for (const k of ['head', 'staff', 'peer', 'orphan', 'loner', 'stranger', 'joiner', 'leaver', 'probie', 'soon', 'kid'])
		await member(k, [], ids[k]);
	await member('ghost', [], null);
	await member('payroll', ['payroll_officer'], null);
	await member('gone', ['hr_admin'], null);
	await withTenant(sys(), (tx) =>
		tx.update(memberships).set({ status: 'disabled' }).where(eq(memberships.id, who.gone.access.membershipId))
	);
});

afterAll(closePools);

describe('leave requests', () => {
	it('refuses requests that break the leave rules', async () => {
		expect(await code(ask('staff', { endDate: addDays(D, -1) }))).toBe('invalid');
		expect(await code(ask('staff', { session: 'am', endDate: addDays(D, 1) }))).toBe('invalid');
		expect(await code(ask('staff', { session: 'night' }))).toBe('invalid');
		expect(await code(ask('staff', { leaveTypeId: 'nope' }))).toBe('invalid');
		expect(await code(ask('staff', { reason: 'x'.repeat(501) }))).toBe('invalid');
		expect(await code(ask('staff', { leaveTypeId: crypto.randomUUID() }))).toBe('unknown_type');
		expect(await code(ask('staff', { leaveTypeId: type.maternity }))).toBe('unknown_type');
		expect(await code(ask('staff', { leaveTypeId: type.old }))).toBe('unknown_type');
		expect(await code(ask('staff', { leaveTypeId: type.sick, session: 'am' }))).toBe('no_half_day');
		expect(await code(ask('staff', { startDate: addDays(year.end, 1) }))).toBe('outside_year');
		expect(await code(ask('staff', { startDate: addDays(year.start, -1) }))).toBe('outside_year');
		expect(await code(ask('staff', { endDate: addDays(year.end, 1) }))).toBe('outside_year');
		expect(await code(ask('joiner'))).toBe('outside_employment');
		expect(await code(ask('leaver', { endDate: work(addDays(D, 1)) }))).toBe('outside_employment');
		expect(await code(ask('staff', { leaveTypeId: type.earned, startDate: addDays(today, 6) }))).toBe('short_notice');
		expect(await code(ask('probie', { leaveTypeId: type.earned }))).toBe('probation');
		expect(await code(ask('soon', { leaveTypeId: type.earned }))).toBe('probation');
		const fri = friday(D);
		expect(await code(ask('staff', { startDate: fri, endDate: addDays(fri, 1) }))).toBe('no_working_days');
		expect(await code(ask('staff', { endDate: workAfter(D, 3) }))).toBe('too_long');
		expect(await code(ask('ghost'))).toBe('no_employee');
		const limited = {
			...who.peer,
			access: { ...who.peer.access, grants: { 'employee.read': ['own'] } }
		} as unknown as Member;
		expect(await code(requestLeave(limited, { leaveTypeId: type.casual, startDate: D, reason: '' }))).toBe('forbidden');
		expect(await withTenant(sys(), (tx) => tx.select().from(leaveRequests))).toEqual([]);
	});

	it('counts working days, holds pending days against the balance and blocks overlaps', async () => {
		expect(await code(ask('soon', { leaveTypeId: type.earned, startDate: work(addDays(D, 1)) }))).toBe('ok');
		expect(await code(ask('probie'))).toBe('ok');
		expect(await code(ask('staff', { leaveTypeId: type.earned, startDate: work(addDays(today, 7)) }))).toBe('ok');
		const end = workAfter(D, 2);
		expect(await code(ask('staff', { endDate: end }))).toBe('ok');
		const r = await latest('staff');
		expect([r.days, r.status, r.startDate, r.endDate]).toEqual([3, 'pending', D, end]);
		expect(await balance('staff', 'Casual leave')).toEqual([10, 3, 7]);
		expect(await code(ask('staff', { session: 'am' }))).toBe('overlap');
		expect(await code(ask('staff', { startDate: end, endDate: work(addDays(end, 1)) }))).toBe('overlap');

		const half = work(addDays(end, 7));
		expect(await code(ask('staff', { startDate: half, session: 'am' }))).toBe('ok');
		expect(await code(ask('staff', { startDate: half, session: 'pm' }))).toBe('ok');
		expect(await code(ask('staff', { startDate: half, session: 'pm' }))).toBe('overlap');
		expect(await code(ask('staff', { startDate: half }))).toBe('overlap');
		expect(await balance('staff', 'Casual leave')).toEqual([10, 4, 6]);

		const pat = work(addDays(half, 7));
		expect(await code(ask('staff', { leaveTypeId: type.paternity, startDate: pat, endDate: workAfter(pat, 4) }))).toBe(
			'ok'
		);
		const more = work(addDays(pat, 14));
		expect(await code(ask('staff', { leaveTypeId: type.paternity, startDate: more }))).toBe('insufficient');
		expect(await code(ask('staff', { leaveTypeId: type.unpaid, startDate: more, endDate: workAfter(more, 25) }))).toBe(
			'ok'
		);
		const unpaid = await latest('staff');
		expect(unpaid.days).toBe(26);
		const v = await view('hr', unpaid.id);
		expect([v?.canDecide, v?.balance]).toEqual([true, null]);
		const [stale] = await withTenant(sys(), (tx) =>
			tx
				.insert(leaveRequests)
				.values({
					tenantId: tenant.id,
					employeeId: ids.staff,
					leaveTypeId: type.casual,
					startDate: addDays(year.start, -10),
					endDate: addDays(year.start, -10),
					session: 'full',
					days: 1,
					requestedByUserId: who.staff.user.userId
				})
				.returning({ id: leaveRequests.id })
		);
		await withTenant(sys(), (tx) =>
			tx.insert(leaveRequestDays).values({
				tenantId: tenant.id,
				requestId: stale.id,
				employeeId: ids.staff,
				date: addDays(year.start, -10),
				session: 'full',
				fiscalYear: Number(today.slice(0, 4)) - 1,
				status: 'pending'
			})
		);
		expect(await balance('staff', 'Casual leave')).toEqual([10, 4, 6]);
	});

	it('sends the request to the manager, who approves it into the ledger', async () => {
		const start = work(addDays(D, 60));
		expect(await code(ask('peer', { startDate: start, endDate: workAfter(start, 1), reason: 'Family visit' }))).toBe(
			'ok'
		);
		const r = await latest('peer');
		expect(await told('boss')).toContain('Pe Peer asked for Casual leave');
		expect(await told('hr')).not.toContain('Pe Peer asked for Casual leave');
		expect(await inbox('boss')).toContain('Pe Peer: Casual leave, 2 days');
		expect(await inbox('hr')).toContain('Pe Peer: Casual leave, 2 days');
		expect(await inbox('big')).toContain('Pe Peer: Casual leave, 2 days');
		expect((await view('big', r.id))?.canDecide).toBe(true);
		expect(await inbox('stranger')).toEqual([]);
		expect(await inbox('peer')).toEqual([]);
		expect(await withTenant(sys(), (tx) => getLeaveRequest(tx, who.stranger.access, r.id))).toBeNull();
		const seen = await withTenant(sys(), (tx) => getLeaveRequest(tx, who.boss.access, r.id));
		expect([seen?.reason, seen?.canDecide, seen?.canCancel, seen?.balance?.available]).toEqual([
			'Family visit',
			true,
			false,
			8
		]);
		const own = await withTenant(sys(), (tx) => getLeaveRequest(tx, who.peer.access, r.id));
		expect([own?.canDecide, own?.canCancel, own?.balance]).toEqual([false, true, null]);

		expect(await code(decide('stranger', r.id))).toBe('not_found');
		expect(await code(decide('peer', r.id))).toBe('self_approval');
		expect(await code(decide('boss', 'nope'))).toBe('not_found');
		expect(await code(decideLeave(who.boss, r.id, { decision: 'maybe', note: '' }))).toBe('invalid');
		expect(await code(decide('boss', r.id))).toBe('ok');
		expect(await code(decide('hr', r.id))).toBe('already_decided');
		expect(await taken(r.id)).toEqual([-2]);
		expect(await balance('peer', 'Casual leave')).toEqual([8, 0, 8]);
		expect(await told('peer')).toContain(`Your leave from ${start} was approved`);
		expect(await inbox('boss')).not.toContain('Pe Peer: Casual leave, 2 days');
		expect((await view('boss', r.id))?.canDecide).toBe(false);
		const days = await withTenant(sys(), (tx) =>
			tx.select({ status: leaveRequestDays.status }).from(leaveRequestDays).where(eq(leaveRequestDays.requestId, r.id))
		);
		expect(days.map((d) => d.status)).toEqual(['approved', 'approved']);
	});

	it('falls back to the department head, then to HR, when there is no manager', async () => {
		const start = work(addDays(D, 70));
		await ask('orphan', { startDate: start });
		expect(await told('head')).toContain('Or Orphan asked for Casual leave');
		expect(await told('hr')).not.toContain('Or Orphan asked for Casual leave');
		expect(await inbox('head')).toEqual(['Or Orphan: Casual leave, 1 day']);
		expect(await code(decide('head', (await latest('orphan')).id, 'reject'))).toBe('ok');
		expect(await balance('orphan', 'Casual leave')).toEqual([10, 0, 10]);
		expect(await told('orphan')).toContain(`Your leave from ${start} was declined`);
		expect(await code(ask('orphan', { startDate: start }))).toBe('ok');

		await ask('loner', { startDate: start });
		expect(await told('hr')).toContain('Lo Loner asked for Casual leave');
		expect(await told('boss')).not.toContain('Lo Loner asked for Casual leave');
		expect(await inbox('head')).toEqual(['Or Orphan: Casual leave, 1 day']);
		expect(await code(decide('head', (await latest('loner')).id))).toBe('not_found');
		expect(await code(decide('payroll', (await latest('loner')).id))).toBe('forbidden');
		for (const k of ['payroll', 'gone']) expect(await told(k)).not.toContain('Lo Loner asked for Casual leave');
		const c = custodian();
		expect((await withTenant(sys(), (tx) => pendingApprovals(tx, c.access))).map((i) => i.title)).toContain(
			'Lo Loner: Casual leave, 1 day'
		);
		expect(await code(decideLeave(c, (await latest('loner')).id, { decision: 'approve', note: '' }))).toBe('ok');

		await ask('head', { startDate: start });
		expect(await told('hr')).toContain('Hd Head asked for Casual leave');
		expect(await told('head')).not.toContain('Hd Head asked for Casual leave');

		await ask('kid', { startDate: start });
		expect(await told('peer')).toContain('Ki Kid asked for Casual leave');
		expect(await inbox('peer')).toEqual(['Ki Kid: Casual leave, 1 day']);
		expect(await code(decide('peer', (await latest('kid')).id))).toBe('ok');
	});

	it('cancels pending or upcoming leave and gives approved days back', async () => {
		const start = work(addDays(D, 80));
		await ask('peer', { startDate: start });
		const pending = await latest('peer');
		expect(await code(cancelLeave(who.stranger, pending.id))).toBe('not_found');
		expect(await code(cancelLeave(who.boss, pending.id))).toBe('forbidden');
		expect(await code(cancelLeave(who.peer, pending.id))).toBe('ok');
		expect(await code(cancelLeave(who.peer, pending.id))).toBe('not_cancellable');
		expect((await latest('peer')).status).toBe('cancelled');
		expect(await taken(pending.id)).toEqual([]);

		await ask('peer', { startDate: start });
		const approved = await latest('peer');
		await decide('boss', approved.id);
		expect(await balance('peer', 'Casual leave')).toEqual([7, 0, 7]);
		expect(await code(cancelLeave(who.hr, approved.id))).toBe('ok');
		expect(await taken(approved.id)).toEqual([-1, 1]);
		expect(await balance('peer', 'Casual leave')).toEqual([8, 0, 8]);
		expect((await told('peer')).filter((t) => t === `Your leave from ${start} was cancelled`)).toHaveLength(1);

		await ask('peer', { startDate: today, endDate: work(addDays(today, 1)) });
		const started = await latest('peer');
		await decide('boss', started.id);
		expect(await code(cancelLeave(who.peer, started.id))).toBe('not_cancellable');
		expect((await view('peer', started.id))?.canCancel).toBe(false);
		expect((await view('peer', approved.id))?.canCancel).toBe(false);
		const mine = await withTenant(sys(), (tx) => myLeave(tx, who.peer.access));
		expect(mine.map((r) => [r.status, r.cancellable])).toEqual([
			['cancelled', false],
			['cancelled', false],
			['approved', true],
			['approved', false]
		]);
	});

	it('drops a new holiday from upcoming leave and refunds approved days', async () => {
		const start = work(addDays(D, 90));
		const mid = workAfter(start, 1);
		await ask('boss', { startDate: start, endDate: workAfter(start, 2) });
		const r = await latest('boss');
		await decide('hr', r.id);
		const half = work(addDays(start, 7));
		await ask('boss', { startDate: half, session: 'pm' });
		const h = await latest('boss');
		await addHoliday(sys(), { date: mid, name: 'Surprise day' });
		await addHoliday(sys(), { date: half, name: 'Second surprise' });
		const past = addDays(today, -3);
		const [old] = await withTenant(sys(), (tx) =>
			tx
				.insert(leaveRequests)
				.values({
					tenantId: tenant.id,
					employeeId: ids.boss,
					leaveTypeId: type.unpaid,
					startDate: past,
					endDate: past,
					session: 'full',
					days: 1,
					status: 'approved',
					requestedByUserId: who.boss.user.userId
				})
				.returning({ id: leaveRequests.id })
		);
		await withTenant(sys(), (tx) =>
			tx.insert(leaveRequestDays).values({
				tenantId: tenant.id,
				requestId: old.id,
				employeeId: ids.boss,
				date: past,
				session: 'full',
				fiscalYear: Number(today.slice(0, 4)),
				status: 'approved'
			})
		);
		await addHoliday(sys(), { date: past, name: 'Past day' });
		const kept = await withTenant(sys(), (tx) =>
			tx
				.select({ status: leaveRequestDays.status })
				.from(leaveRequestDays)
				.where(eq(leaveRequestDays.requestId, old.id))
		);
		expect(kept).toEqual([{ status: 'approved' }]);
		const row = async (id: string) =>
			(await withTenant(sys(), (tx) => tx.select().from(leaveRequests).where(eq(leaveRequests.id, id))))[0];
		expect([(await row(h.id)).days, (await row(h.id)).status]).toEqual([0, 'cancelled']);
		expect([(await row(r.id)).days, (await row(r.id)).status]).toEqual([2, 'approved']);
		expect(await taken(r.id)).toEqual([-3, 1]);
		expect(await taken(h.id)).toEqual([]);
		expect((await view('hr', h.id))?.dates).toEqual([half]);
		const two = work(addDays(half, 7));
		await ask('boss', { startDate: two, endDate: workAfter(two, 1) });
		const p = await latest('boss');
		await addHoliday(sys(), { date: two, name: 'Third surprise' });
		await decide('hr', p.id);
		expect(await taken(p.id)).toEqual([-1]);
		expect((await view('hr', p.id))?.dates).toEqual([workAfter(two, 1)]);
		expect(await balance('boss', 'Casual leave')).toEqual([7, 0, 7]);
		const seen = await withTenant(sys(), (tx) => getLeaveRequest(tx, who.hr.access, r.id));
		expect(seen?.dates).toEqual([start, workAfter(start, 2)]);
	});

	it('imports holidays all or nothing and drops them from upcoming leave', async () => {
		const start = work(addDays(D, 150));
		const next = workAfter(start, 1);
		await ask('boss', { startDate: start, endDate: next });
		const r = await latest('boss');
		const taken = work(addDays(start, 14));
		await addHoliday(sys(), { date: taken, name: 'Already there' });
		const failed = await importHolidays(sys(), [
			['name', 'date'],
			['Flood day', start],
			['Flood again', start],
			['Bad', '2026-02-30'],
			['', next],
			['Twice', taken]
		]).catch((e: { rows?: unknown }) => e.rows);
		expect(failed).toEqual([
			{ line: 3, message: 'This date appears twice in the file.' },
			{ line: 4, message: 'Pick a valid date.' },
			{ line: 5, message: 'Enter a name.' },
			{ line: 6, message: 'That date is already a holiday.' }
		]);
		const holidaysOn = (d: string) => withTenant(sys(), (tx) => tx.select().from(holidays).where(eq(holidays.date, d)));
		expect(await holidaysOn(start)).toEqual([]);
		expect(
			await importHolidays(sys(), [
				['date', 'name'],
				[start, 'Flood day'],
				[next, 'Flood day two']
			])
		).toBe(2);
		const [after] = await withTenant(sys(), (tx) => tx.select().from(leaveRequests).where(eq(leaveRequests.id, r.id)));
		expect([after.days, after.status]).toEqual([0, 'cancelled']);
	});

	it('recomputes attendance only on the imported holiday dates, not every day between them', async () => {
		const first = work(addDays(today, -60));
		const last = work(addDays(today, -20));
		const inBetween = and(gt(attendanceDays.date, first), lt(attendanceDays.date, last));
		await withTenant(sys(), (tx) => tx.delete(attendanceDays).where(inBetween));
		expect(
			await importHolidays(sys(), [
				['date', 'name'],
				[first, 'Spring day'],
				[last, 'Autumn day']
			])
		).toBe(2);
		expect(await withTenant(sys(), (tx) => tx.select().from(attendanceDays).where(inBetween))).toEqual([]);
	});

	it('lets only one of two racing requests for the same days through', async () => {
		const start = work(addDays(D, 120));
		const results = await Promise.all(
			[ask('loner', { startDate: start }), ask('loner', { startDate: start })].map(code)
		);
		expect(results.sort()).toEqual(['ok', 'overlap']);
		const won = await latest('loner');
		const decided = await Promise.all(
			[decide('hr', won.id), decideLeave(custodian(), won.id, { decision: 'approve', note: '' })].map(code)
		);
		expect(decided.sort()).toEqual(['already_decided', 'ok']);
		expect(await taken(won.id)).toEqual([-1]);
		const a = work(addDays(start, 7));
		const b = work(addDays(a, 7));
		const pair = await Promise.all(
			[
				ask('loner', { leaveTypeId: type.paternity, startDate: a, endDate: workAfter(a, 2) }),
				ask('loner', { leaveTypeId: type.paternity, startDate: b, endDate: workAfter(b, 2) })
			].map(code)
		);
		expect(pair.sort()).toEqual(['insufficient', 'ok']);
	});

	it('shows who is out, with the type only where the viewer may see leave', async () => {
		const out = async (key: string) =>
			(await withTenant(sys(), (tx) => whoIsOut(tx, who[key].access, today, addDays(today, 400)))).map(
				(o) => `${o.name}/${o.type}`
			);
		expect(await out('hr')).toContain('Pe Peer/Casual leave');
		expect(await out('boss')).toContain('Pe Peer/Casual leave');
		expect(await out('hr')).not.toContain('Bo Boss/Unpaid leave');
		expect(await out('stranger')).toEqual([]);
		const start = work(addDays(D, 130));
		await ask('orphan', { startDate: start, endDate: start });
		await decide('head', (await latest('orphan')).id);
		expect(await out('stranger')).toEqual(['Or Orphan/Out']);
		expect(await out('orphan')).toEqual(['Or Orphan/Casual leave']);
		expect(await withTenant(sys(), (tx) => whoIsOut(tx, who.orphan.access, today, addDays(today, 1)))).toEqual([]);
	});

	it('lets HR decide their own leave only when single-admin approval is on', async () => {
		await ask('hr', { startDate: work(addDays(D, 140)) });
		const r = await latest('hrEmp');
		expect(await told('hr')).not.toContain('Ha HR asked for Casual leave');
		expect(await inbox('hr')).not.toContain('Ha HR: Casual leave, 1 day');
		expect(await code(decide('hr', r.id))).toBe('self_approval');
		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ allowSingleAdminApproval: true }));
		expect(await inbox('hr')).toContain('Ha HR: Casual leave, 1 day');
		expect(await code(decide('hr', r.id))).toBe('ok');
	});

	it('keeps a prescription with the request, readable by deciders and editable while pending', async () => {
		const scan = () => new File(['%PDF-1.7 rx'], 'prescription.pdf');
		const day = workAfter(D, 25);
		const id = await requestLeave(
			who.kid,
			{ leaveTypeId: type.sick, startDate: day, endDate: '', session: 'full', reason: 'Fever' },
			[scan()]
		);
		const files = (key: string) => withTenant(sys(), (tx) => listFiles(tx, who[key].access, 'leave_request', id));
		const own = await files('kid');
		expect(own?.files.map((f) => f.filename)).toEqual(['prescription.pdf']);
		expect(own?.canEdit).toBe(true);
		expect((await files('peer'))?.canEdit).toBe(false);
		expect(await files('hr')).not.toBeNull();
		expect(await files('payroll')).toBeNull();
		expect(await files('staff')).toBeNull();
		expect(await code(openFile(who.payroll, own!.files[0].id))).toBe('not_found');
		expect(await code(addFiles(who.peer, 'leave_request', id, [scan()]))).toBe('forbidden');
		const [second] = await addFiles(who.kid, 'leave_request', id, [scan()]);
		await removeFile(who.kid, { type: 'leave_request', id }, second);
		expect(await code(decide('peer', id))).toBe('ok');
		expect((await files('kid'))?.canEdit).toBe(false);
		expect(await code(addFiles(who.kid, 'leave_request', id, [scan()]))).toBe('forbidden');
		expect((await openFile(who.peer, own!.files[0].id)).fileName).toBe('prescription.pdf');
	});

	it('stores nothing when a request with files is refused', async () => {
		const before = (await withTenant(sys(), (tx) => tx.select().from(leaveRequests))).length;
		expect(
			await code(
				requestLeave(
					who.kid,
					{ leaveTypeId: type.casual, startDate: addDays(year.end, 1), endDate: '', session: 'full', reason: '' },
					[new File(['%PDF-1.7 x'], 'x.pdf')]
				)
			)
		).toBe('outside_year');
		expect(
			await code(
				requestLeave(who.kid, { leaveTypeId: type.casual, startDate: D, endDate: '', session: 'full', reason: '' }, [
					new File(['MZ'], 'x.exe')
				])
			)
		).toBe('unsupported_file');
		expect((await withTenant(sys(), (tx) => tx.select().from(leaveRequests))).length).toBe(before);
	});
});
