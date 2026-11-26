import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recomputeAttendance } from '../../src/lib/server/attendance';
import { closePools, ownerPool } from '../../src/lib/server/db';
import {
	attendanceDays,
	leaveTypes,
	mealOrders,
	mealTypePrices,
	memberships,
	payComponents,
	payslipLines,
	payslips,
	tenantSettings,
	workWeekAssignments
} from '../../src/lib/server/db/schema';
import { addDays, addMonths, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { accrue } from '../../src/lib/server/leave';
import { decideLeave, requestLeave } from '../../src/lib/server/leave-requests';
import { chooseMeal, prepareMealDay, unlockedDays } from '../../src/lib/server/meal-orders';
import { mealSetup, saveMealType, saveVendor } from '../../src/lib/server/meals';
import { periodRange } from '../../src/lib/server/meal-bills';
import { startRun } from '../../src/lib/server/payroll';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { closeQueues } from '../../src/lib/server/queue';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { decideSalary, proposeSalary } from '../../src/lib/server/salaries';
import { startTaxYear } from '../../src/lib/server/tax';
import { systemCtx, withTenant, type Tx } from '../../src/lib/server/tenancy';
import { fiscalYearOf } from '../../src/lib/tax';
import {
	assignWorkWeek,
	createWorkWeek,
	employeeWorkWeek,
	listWorkWeeks,
	removeWorkWeekAssignment,
	updateWorkWeek
} from '../../src/lib/server/work-weeks';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
let P: string;
const ids: Record<string, string> = {};
const week: Record<string, string> = {};
const who: Record<string, Member> = {};
const today = dateIn(new Date(), TEST_LOCALE.timezone);
const all = () => ({ ...systemCtx(tenant.id), payrollAll: true, salaryAll: true });
const db = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(all(), fn);
const ctx = () => ({ tenantId: tenant.id, actor: 'user' as const });
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
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const next = (from: string, dow: number) => addDays(from, (dow - weekday(from) + 7) % 7);
const hire = (fullName: string, joinDate: string) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate
	});

async function member(key: string, roleKeys: string[], employeeId: string | null) {
	const u = await createUser();
	const id = await withTenant(systemCtx(tenant.id), async (tx) => {
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

const assign = (key: string, employeeId: string, name: string, effectiveFrom: string) =>
	code(assignWorkWeek(who[key], employeeId, { workWeekId: week[name], effectiveFrom }));

async function leave(key: string, startDate: string, endDate: string) {
	const [casual] = await db((tx) => tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'casual')));
	await requestLeave(who[key], { leaveTypeId: casual.id, startDate, endDate, session: 'full', reason: '' }, []);
	const [r] = await ownerPool().sql<{ id: string }[]>`
		select id from leave_requests where employee_id = ${ids[key]} order by created_at desc limit 1`;
	await decideLeave(who.hr, r.id, { decision: 'approve', note: '' });
	return r.id;
}

const run = (type: string, period: string, status: string, employeeId: string | null) =>
	ownerPool().sql`
		insert into payroll_runs (tenant_id, run_type, period, status, employee_id, inputs_hash, output_hash, computed_by_user_id, computed_at)
		values (${tenant.id}, ${type}, ${period}, ${status}, ${employeeId}, 'x', 'x', ${who.hr.user.userId}, now())`;

const activeDays = async (requestId: string) =>
	(
		await ownerPool().sql<{ date: string }[]>`
			select to_char(date, 'YYYY-MM-DD') as date from leave_request_days
			where request_id = ${requestId} and status in ('pending','approved') order by date`
	).map((r) => r.date);

const casualBalance = async (employeeId: string) => {
	const [r] = await ownerPool().sql<{ days: string }[]>`
		select coalesce(sum(l.days), 0) as days from leave_ledger l join leave_types t on t.id = l.leave_type_id
		where l.employee_id = ${employeeId} and t.code = 'casual'`;
	return Number(r.days);
};

beforeAll(async () => {
	tenant = await createTenant('workweeks');
	await withTenant(systemCtx(tenant.id), async (tx) => {
		await seedTenant(tx, tenant.id, TEST_LOCALE);
		await tx
			.update(tenantSettings)
			.set({ payrollProrationBasis: 'working', mealMode: 'opt_out', mealWorkingDaysOnly: true });
	});
	P = addMonths(today.slice(0, 7), -1);
	ids.ana = await hire('Ww Ana', `${P}-10`);
	ids.ben = await hire('Ww Ben', `${P}-10`);
	ids.cal = await hire('Ww Cal', '2026-01-01');
	ids.dee = await hire('Ww Dee', addDays(today, 40));
	ids.eli = await hire('Ww Eli', '2026-01-01');
	await ownerPool().sql`update employees set status = 'notice', exit_date = ${addDays(today, 5)} where id = ${ids.eli}`;
	await member('ana', ['employee'], ids.ana);
	await member('ben', ['employee'], ids.ben);
	await member('hr', ['hr_admin'], null);
	await member('po', ['payroll_officer'], null);
	await member('fin', ['finance'], null);
	await withTenant(systemCtx(tenant.id), (tx) => accrue(tx, tenant.id));

	expect(await code(createWorkWeek(ctx(), { name: 'Sat-Sun', weekendDays: ['6', '0', '6'], active: 'on' }))).toBe('ok');
	expect(await code(createWorkWeek(ctx(), { name: 'Fri-Sat', weekendDays: ['5', '6'], active: 'on' }))).toBe('ok');
	expect(await code(createWorkWeek(ctx(), { name: 'Old', weekendDays: ['0'] }))).toBe('ok');
	for (const w of await db(listWorkWeeks)) week[w.name] = w.id;
	await ownerPool().sql`
		insert into work_week_assignments (tenant_id, employee_id, work_week_id, effective_from)
		values (${tenant.id}, ${ids.ben}, ${week['Sat-Sun']}, '2026-01-01')`;
});

afterAll(async () => {
	await closeQueues();
	await closePools();
});

describe('work weeks', () => {
	it('keep names unique, need a working day and lock the days once in use', async () => {
		const weeks = await db(listWorkWeeks);
		expect(weeks.map((w) => [w.name, w.weekendDays, w.active, w.used])).toEqual([
			['Fri-Sat', [5, 6], true, false],
			['Old', [0], false, false],
			['Sat-Sun', [0, 6], true, true]
		]);
		expect(await code(createWorkWeek(ctx(), { name: 'Sat-Sun', weekendDays: ['1'], active: 'on' }))).toBe('duplicate');
		expect(
			await code(
				createWorkWeek(ctx(), { name: 'Never', weekendDays: ['0', '1', '2', '3', '4', '5', '6'], active: 'on' })
			)
		).toBe('invalid');
		expect(await code(createWorkWeek(ctx(), { name: 'Bad', weekendDays: ['7'], active: 'on' }))).toBe('invalid');
		expect(await code(createWorkWeek(ctx(), { name: 'Bad', weekendDays: [''], active: 'on' }))).toBe('invalid');
		expect(await code(createWorkWeek(ctx(), { name: 'Bad', weekendDays: ['1.0'], active: 'on' }))).toBe('invalid');
		expect(await code(createWorkWeek(ctx(), { name: 'Mondays', weekendDays: Array(7).fill('1') }))).toBe('ok');
		expect((await db(listWorkWeeks)).find((w) => w.name === 'Mondays')?.weekendDays).toEqual([1]);
		expect(await code(createWorkWeek(ctx(), { name: ' ', weekendDays: [], active: 'on' }))).toBe('invalid');
		expect(
			await code(updateWorkWeek(ctx(), week['Sat-Sun'], { name: 'Sat-Sun', weekendDays: ['6'], active: 'on' }))
		).toBe('in_use');
		expect(
			await code(updateWorkWeek(ctx(), week['Sat-Sun'], { name: 'Sat-Sun', weekendDays: ['0', '6'], active: 'on' }))
		).toBe('ok');
		expect(
			await code(updateWorkWeek(ctx(), week['Fri-Sat'], { name: 'Sat-Sun', weekendDays: ['5', '6'], active: 'on' }))
		).toBe('duplicate');
		expect(await code(updateWorkWeek(ctx(), crypto.randomUUID(), { name: 'X', weekendDays: [], active: 'on' }))).toBe(
			'not_found'
		);
	});

	it('mark each person’s own weekend in attendance', async () => {
		const fri = next(`${P}-12`, 5);
		const sun = addDays(fri, 2);
		await db((tx) => recomputeAttendance(tx, tenant.id, fri, sun, [ids.ana, ids.ben]));
		const rows = await db((tx) =>
			tx
				.select({ e: attendanceDays.employeeId, date: attendanceDays.date, status: attendanceDays.status })
				.from(attendanceDays)
				.where(and(inArray(attendanceDays.employeeId, [ids.ana, ids.ben]), inArray(attendanceDays.date, [fri, sun])))
		);
		const status = (e: string, d: string) => rows.find((r) => r.e === e && r.date === d)?.status;
		expect([status(ids.ana, fri), status(ids.ana, sun)]).toEqual(['weekend', 'absent']);
		expect([status(ids.ben, fri), status(ids.ben, sun)]).toEqual(['absent', 'weekend']);
	});

	it('count leave days on each person’s own working days', async () => {
		const fri = next(addDays(today, 14), 5);
		const anaLeave = await leave('ana', fri, addDays(fri, 2));
		const benLeave = await leave('ben', fri, addDays(fri, 2));
		expect(await activeDays(anaLeave)).toEqual([addDays(fri, 2)]);
		expect(await activeDays(benLeave)).toEqual([fri]);
	});

	it('prorate payroll on each person’s own working days', async () => {
		await db(async (tx) => {
			const comps = await tx.select().from(payComponents).where(eq(payComponents.code, 'BASIC'));
			week.basic = comps[0].id;
		});
		for (const e of [ids.ana, ids.ben]) {
			const changeId = await proposeSalary(who.po, {
				employeeId: e,
				effectiveFrom: `${P}-10`,
				reason: 'Offer',
				[`c_${week.basic}`]: '30000'
			});
			await decideSalary(who.fin, { changeId, decision: 'approve', note: '' });
		}
		await member('adm', ['hr_admin'], null);
		await startTaxYear(who.adm, { fy: fiscalYearOf(`${P}-01`) });
		const runId = await startRun(who.po, { period: P });
		const { from, to } = periodRange(P);
		const days: string[] = [];
		for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
		const expected = (weekend: number[]) => {
			const working = days.filter((d) => !weekend.includes(weekday(d)));
			return Math.round((3_000_000 * working.filter((d) => d >= `${P}-10`).length) / working.length);
		};
		const basic = async (e: string) => {
			const [line] = await db((tx) =>
				tx
					.select({ amount: payslipLines.amount })
					.from(payslipLines)
					.innerJoin(payslips, eq(payslips.id, payslipLines.payslipId))
					.where(and(eq(payslips.runId, runId), eq(payslips.employeeId, e), eq(payslipLines.code, 'BASIC')))
			);
			return line?.amount;
		};
		expect([await basic(ids.ana), await basic(ids.ben)]).toEqual([expected([5, 6]), expected([0, 6])]);
		expect(expected([5, 6])).not.toBe(expected([0, 6]));
	});

	it('order meals for whoever works that day and keep the kitchen open', async () => {
		const ctxUser = ctx();
		await saveVendor(ctxUser, '', { name: 'Rice Bowl', contact: '', active: 'on' });
		const setup = await db(mealSetup);
		await saveMealType(ctxUser, '', { name: 'Lunch', vendorId: setup.vendors[0].id, active: 'on' });
		const [lunch] = (await db(mealSetup)).types;
		await db((tx) =>
			tx
				.insert(mealTypePrices)
				.values({ tenantId: tenant.id, mealTypeId: lunch.id, effectiveFrom: today, unitCost: 8000, subsidyPct: 0 })
		);
		const fri = next(addDays(today, 2), 5);
		const sat = addDays(fri, 1);
		const sun = addDays(fri, 2);
		const pick = (key: string, date: string) =>
			code(chooseMeal(who[key], { date, mealTypeId: lunch.id, status: 'ordered', guestQty: '0' }));
		expect([
			await pick('ana', addDays(fri, 7)),
			await pick('ben', addDays(fri, 7)),
			await pick('ben', addDays(fri, 8))
		]).toEqual(['not_served', 'ok', 'not_served']);
		for (const d of [fri, sat, sun]) await db((tx) => prepareMealDay(tx, tenant.id, d));
		const orders = await db((tx) =>
			tx
				.select({ e: mealOrders.employeeId, date: mealOrders.date, status: mealOrders.status })
				.from(mealOrders)
				.where(inArray(mealOrders.date, [fri, sat, sun]))
		);
		const status = (e: string, d: string) => orders.find((o) => o.e === e && o.date === d)?.status ?? null;
		expect([status(ids.ana, fri), status(ids.ben, fri), status(ids.cal, fri)]).toEqual([null, 'ordered', null]);
		expect([status(ids.ana, sun), status(ids.ben, sun), status(ids.cal, sun)]).toEqual(['ordered', null, 'ordered']);
		expect([status(ids.ana, sat), status(ids.ben, sat), status(ids.cal, sat)]).toEqual([null, null, null]);
		expect(await db((tx) => unlockedDays(tx, addDays(fri, 7), addDays(fri, 9)))).toEqual([
			addDays(fri, 7),
			addDays(fri, 9)
		]);
	});

	it('change future days only, for people HR manages, inside their employment', async () => {
		expect(await assign('hr', ids.cal, 'Sat-Sun', addDays(today, -1))).toBe('past_date');
		expect(await assign('hr', ids.dee, 'Sat-Sun', addDays(today, 1))).toBe('before_join');
		expect(await assign('hr', ids.eli, 'Sat-Sun', addDays(today, 6))).toBe('after_exit');
		expect(await assign('hr', ids.eli, 'Sat-Sun', addDays(today, 5))).toBe('ok');
		expect(await assign('hr', ids.cal, 'Old', addDays(today, 1))).toBe('unknown_work_week');
		expect(await code(assignWorkWeek(who.hr, ids.cal, { workWeekId: crypto.randomUUID(), effectiveFrom: today }))).toBe(
			'unknown_work_week'
		);
		expect(await assign('ana', ids.cal, 'Sat-Sun', addDays(today, 1))).toBe('not_found');
		expect(await assign('ana', ids.ana, 'Sat-Sun', addDays(today, 1))).toBe('forbidden');
		expect(await assign('hr', ids.cal, 'Sat-Sun', addDays(today, 1))).toBe('ok');
		const [old] = await db((tx) =>
			tx.select().from(workWeekAssignments).where(eq(workWeekAssignments.employeeId, ids.ben))
		);
		expect(await code(removeWorkWeekAssignment(who.hr, ids.ben, old.id))).toBe('past_date');
		expect(await code(removeWorkWeekAssignment(who.hr, ids.cal, old.id))).toBe('not_found');
		const view = await db((tx) => employeeWorkWeek(tx, who.hr.access, { id: ids.cal }, today));
		expect(view?.current).toEqual({ name: null, weekendDays: TEST_LOCALE.weekendDays });
		expect(view?.history.map((h) => [h.effectiveFrom, h.name])).toEqual([[addDays(today, 1), 'Sat-Sun']]);
		expect(view?.choices.map((c) => c.name)).toEqual(['Fri-Sat', 'Sat-Sun']);
		expect(await code(removeWorkWeekAssignment(who.hr, ids.cal, view!.history[0].id))).toBe('ok');
		expect(await db((tx) => employeeWorkWeek(tx, who.ben.access, { id: ids.ben }, today))).toMatchObject({
			current: { name: 'Sat-Sun', weekendDays: [0, 6] },
			canManage: false,
			choices: []
		});
	});

	it('drop and refund leave days that become rest days', async () => {
		const thu = next(addDays(today, 21), 4);
		const request = await leave('ben', thu, addDays(thu, 1));
		expect(await activeDays(request)).toEqual([thu, addDays(thu, 1)]);
		const before = await casualBalance(ids.ben);
		expect(await assign('hr', ids.ben, 'Fri-Sat', addDays(thu, -1))).toBe('ok');
		expect(await activeDays(request)).toEqual([thu]);
		expect(await casualBalance(ids.ben)).toBe(before + 1);
		const [r] = await ownerPool().sql<{ days: string; status: string }[]>`
			select days, status from leave_requests where id = ${request}`;
		expect([Number(r.days), r.status]).toEqual([1, 'approved']);
		const [undo] = await db((tx) =>
			tx
				.select()
				.from(workWeekAssignments)
				.where(
					and(eq(workWeekAssignments.employeeId, ids.ben), eq(workWeekAssignments.effectiveFrom, addDays(thu, -1)))
				)
		);
		expect(await code(removeWorkWeekAssignment(who.hr, ids.ben, undo.id))).toBe('ok');
		expect(await activeDays(request)).toEqual([thu]);
		expect(await casualBalance(ids.ben)).toBe(before + 1);
	});

	it('refuse a change that turns booked leave rest days into working days', async () => {
		const thu = next(addDays(today, 28), 4);
		const request = await leave('ana', thu, addDays(thu, 3));
		expect(await activeDays(request)).toEqual([thu, addDays(thu, 3)]);
		expect(await assign('hr', ids.ana, 'Sat-Sun', addDays(thu, -1))).toBe('leave_conflict');
		expect(await assign('hr', ids.ana, 'Sat-Sun', addDays(thu, 1))).toBe('leave_conflict');
		expect(await activeDays(request)).toEqual([thu, addDays(thu, 3)]);
		const rows = await db((tx) =>
			tx.select().from(workWeekAssignments).where(eq(workWeekAssignments.employeeId, ids.ana))
		);
		expect(rows).toEqual([]);
	});

	it('refuse a change inside a month whose payroll is approved', async () => {
		const later = addMonths(today.slice(0, 7), 3);
		await run('regular', later, 'approved', null);
		expect(await assign('hr', ids.cal, 'Sat-Sun', addDays(today, 3))).toBe('payroll_closed');
		expect(await assign('hr', ids.cal, 'Sat-Sun', `${addMonths(later, 1)}-01`)).toBe('ok');
		const end = addMonths(later, 2);
		await run('final', end, 'computed', ids.cal);
		expect(await assign('hr', ids.cal, 'Fri-Sat', `${end}-01`)).toBe('payroll_closed');
		expect(await assign('hr', ids.ben, 'Sat-Sun', `${end}-01`)).toBe('ok');
	});
});
