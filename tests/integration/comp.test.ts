import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	applyCycle,
	clearProposal,
	closeCycle,
	createCycle,
	cyclePage,
	cyclesPage,
	propose,
	setBudget
} from '../../src/lib/server/comp';
import { closePools } from '../../src/lib/server/db';
import {
	compBudgets,
	compProposals,
	departments,
	employeeSalaries,
	employees,
	memberships,
	payComponents,
	salaryChanges
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { decideSalary, proposeSalary } from '../../src/lib/server/salaries';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const dept: Record<string, string> = {};
const comp: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const sal = () => ({ ...sys(), salaryAll: true });
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (fullName: string) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01'
	});

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

async function pay(employeeId: string, effectiveFrom: string, basic: string) {
	const id = await proposeSalary(who.po, {
		employeeId,
		effectiveFrom,
		reason: 'Salary',
		[`c_${comp.BASIC}`]: basic,
		[`c_${comp.HOUSE_RENT}`]: '50',
		[`c_${comp.MEDICAL}`]: '1000'
	});
	await decideSalary(who.fin, { changeId: id, decision: 'approve', note: '' });
}
const current = (employeeId: string) =>
	withTenant(sal(), async (tx) => {
		const rows = await tx.select().from(employeeSalaries).where(eq(employeeSalaries.employeeId, employeeId));
		return rows.find((r) => !r.effectiveTo)!.gross;
	});
const proposal = (employeeId: string, cycleId = cycle) =>
	withTenant(
		sal(),
		async (tx) =>
			(
				await tx
					.select()
					.from(compProposals)
					.where(and(eq(compProposals.employeeId, employeeId), eq(compProposals.cycleId, cycleId)))
			)[0]
	);

let cycle = '';

beforeAll(async () => {
	tenant = await createTenant('comp');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	for (const n of ['mgr', 'ann', 'bob', 'cat', 'fin', 'pat']) ids[n] = await hire(n);
	await withTenant(sys(), async (tx) => {
		for (const name of ['Engineering', 'Operations']) {
			const [d] = await tx.insert(departments).values({ tenantId: tenant.id, name }).returning();
			dept[name] = d.id;
		}
		const eng = { departmentId: dept.Engineering };
		await tx.update(employees).set(eng).where(eq(employees.id, ids.mgr));
		await tx
			.update(employees)
			.set({ ...eng, managerId: ids.mgr })
			.where(eq(employees.id, ids.ann));
		await tx
			.update(employees)
			.set({ ...eng, managerId: ids.mgr })
			.where(eq(employees.id, ids.bob));
		await tx
			.update(employees)
			.set({ departmentId: dept.Operations })
			.where(inArray(employees.id, [ids.cat, ids.pat]));
		for (const c of await tx.select().from(payComponents)) comp[c.code] = c.id;
	});
	await member('mgr', ['line_manager', 'employee'], ids.mgr);
	await member('ann', ['employee'], ids.ann);
	await member('hr', ['owner'], null);
	await member('hra', ['hr_admin'], null);
	await member('pe', ['payroll_officer'], ids.pat);
	await member('po', ['payroll_officer'], null);
	await member('fin', ['finance', 'employee'], ids.fin);
	for (const n of ['mgr', 'ann', 'bob', 'cat', 'pat']) await pay(ids[n], '2026-01-01', '20000');
	who.blind = {
		...who.po,
		access: { ...who.po.access, grants: { 'comp.manage': ['all'], 'comp.propose': ['all'] } }
	} as Member;
});

afterAll(closePools);

describe('pay reviews', () => {
	it('lets HR start a review with checked fields and keeps names unique', async () => {
		expect(await code(createCycle(who.mgr, { name: 'X', effectiveFrom: '2026-07-01', guideline: '' }))).toBe(
			'forbidden'
		);
		expect(await code(createCycle(who.hr, { name: 'X', effectiveFrom: '2026-07-01', guideline: '101' }))).toBe(
			'invalid: Enter a percentage from 0.01 to 100.'
		);
		expect(await code(createCycle(who.hr, { name: 'X', effectiveFrom: '0000-01-01', guideline: '' }))).toBe(
			'invalid: Enter a date between 2000 and 2099.'
		);
		cycle = await createCycle(who.hr, { name: 'Mid-year 2026', effectiveFrom: '2026-07-01', guideline: '8' });
		expect(await code(createCycle(who.hr, { name: 'Mid-year 2026', effectiveFrom: '2026-08-01', guideline: '' }))).toBe(
			'duplicate'
		);
		expect((await cyclesPage(who.mgr)).cycles.map((c) => c.name)).toContain('Mid-year 2026');
		expect(await code(cyclesPage(who.ann))).toBe('forbidden');
		expect(await code(cyclesPage(who.hra))).toBe('forbidden');
	});

	it('shows a manager their team only, never themselves, and no salaries they cannot read', async () => {
		await propose(who.mgr, { cycleId: cycle, employeeId: ids.ann, pct: '10', reason: 'Strong year' });
		expect(await code(propose(who.mgr, { cycleId: cycle, employeeId: ids.cat, pct: '5', reason: 'x' }))).toBe(
			'not_found'
		);
		expect(await code(propose(who.mgr, { cycleId: cycle, employeeId: ids.mgr, pct: '5', reason: 'x' }))).toBe(
			'not_found'
		);
		expect(await code(propose(who.mgr, { cycleId: cycle, employeeId: ids.bob, pct: '0', reason: 'x' }))).toBe(
			'invalid: Enter a percentage from 0.01 to 100.'
		);
		const page = await cyclePage(who.mgr, cycle);
		expect(page.rows.map((r) => r.name).sort()).toEqual(['ann', 'bob']);
		const ann = page.rows.find((r) => r.id === ids.ann)!;
		expect(ann.currentGross).toBeNull();
		expect(ann.proposal).toMatchObject({ changeBp: 1000, proposedGross: null, status: 'proposed' });
		expect(page.budgets).toEqual([]);
		expect(JSON.stringify(page)).not.toContain(String(await current(ids.ann)));
		const p = await proposal(ids.ann);
		expect(p).toMatchObject({ currentGross: 3_100_000, proposedGross: 3_410_000, changeBp: 1000 });
	});

	it('gives HR budgets per department with what the proposals use', async () => {
		expect(await code(setBudget(who.mgr, { cycleId: cycle, departmentId: dept.Engineering, budget: '1000' }))).toBe(
			'forbidden'
		);
		await setBudget(who.hr, { cycleId: cycle, departmentId: dept.Engineering, budget: '2000' });
		await setBudget(who.hr, { cycleId: cycle, departmentId: dept.Engineering, budget: '3000' });
		await propose(who.hr, { cycleId: cycle, employeeId: ids.bob, pct: '5', reason: 'Steady' });
		await propose(who.hr, { cycleId: cycle, employeeId: ids.cat, pct: '20', reason: 'Promotion' });
		const page = await cyclePage(who.hr, cycle);
		expect(page.budgets.find((b) => b.id === dept.Engineering)).toMatchObject({
			budget: 300_000,
			used: 310_000 + 155_000
		});
		expect(page.budgets.find((b) => b.id === dept.Operations)).toMatchObject({ budget: null, used: 620_000 });
		expect(page.rows.find((r) => r.id === ids.cat)!.currentGross).toBe(3_100_000);
		expect((await cyclePage(who.hr, cycle, 'an')).rows.map((r) => r.name)).toEqual(['ann']);
		expect((await cyclePage(who.hr, cycle, '%')).rows).toEqual([]);
	});

	it('shows no amounts or budgets to a review manager who cannot read every salary', async () => {
		const page = await cyclePage(who.blind, cycle);
		expect(page.money).toBe(false);
		expect(page.budgets).toEqual([]);
		expect(page.rows.every((r) => r.currentGross === null && (r.proposal?.proposedGross ?? null) === null)).toBe(true);
		expect(page.canApply).toBe(false);
		expect(await code(applyCycle(who.blind, { cycleId: cycle }))).toBe('forbidden');
	});

	it('keeps budgets and proposals away from people without the salary flag', async () => {
		const rows = await withTenant(userCtx(who.ann), async (tx) => ({
			budgets: await tx.select().from(compBudgets),
			proposals: await tx.select().from(compProposals)
		}));
		expect(rows.budgets).toEqual([]);
		expect(rows.proposals).toEqual([]);
	});

	it('applies proposals as pending salary changes only, reporting the ones it cannot apply', async () => {
		await proposeSalary(who.po, {
			employeeId: ids.bob,
			effectiveFrom: '2026-05-01',
			reason: 'Waiting',
			[`c_${comp.BASIC}`]: '21000'
		});
		await pay(ids.cat, '2026-03-01', '25000');
		const before = await current(ids.ann);
		const result = await applyCycle(who.po, { cycleId: cycle });
		expect(result.applied).toBe(1);
		expect(result.failures).toEqual([
			{ name: 'bob', message: 'A salary change is already waiting for approval.' },
			{ name: 'cat', message: 'The salary changed after this proposal. Save the proposal again.' }
		]);
		expect(await current(ids.ann)).toBe(before);
		const p = await proposal(ids.ann);
		expect(p.status).toBe('applied');
		const [change] = await withTenant(sal(), (tx) =>
			tx.select().from(salaryChanges).where(eq(salaryChanges.id, p.salaryChangeId!))
		);
		expect(change).toMatchObject({
			status: 'pending',
			employeeId: ids.ann,
			gross: 3_410_000,
			effectiveFrom: '2026-07-01',
			reason: 'Mid-year 2026: Strong year',
			requestedByUserId: who.po.user.userId
		});
		expect((await proposal(ids.bob)).status).toBe('proposed');
		expect((await cyclePage(who.hr, cycle)).rows.find((r) => r.id === ids.cat)!.proposal!.stale).toBe(true);
		expect((await applyCycle(who.po, { cycleId: cycle })).applied).toBe(0);
		expect(await code(propose(who.mgr, { cycleId: cycle, employeeId: ids.ann, pct: '12', reason: 'More' }))).toBe(
			'applied'
		);
		expect(await code(clearProposal(who.mgr, { cycleId: cycle, employeeId: ids.ann }))).toBe('not_found');
		await decideSalary(who.fin, { changeId: change.id, decision: 'approve', note: '' });
		expect(await current(ids.ann)).toBe(3_410_000);
	});

	it('never applies your own raise and reopens a proposal finance rejected', async () => {
		const year = await createCycle(who.hr, { name: 'Year-end 2026', effectiveFrom: '2026-12-01', guideline: '' });
		await propose(who.hr, { cycleId: year, employeeId: ids.ann, pct: '5', reason: 'Year end' });
		await propose(who.hr, { cycleId: year, employeeId: ids.pat, pct: '50', reason: 'Big jump' });
		const own = await applyCycle(who.pe, { cycleId: year });
		expect(own).toEqual({ applied: 1, failures: [{ name: 'pat', message: 'You cannot apply your own raise.' }] });
		const p = await proposal(ids.ann, year);
		await decideSalary(who.fin, { changeId: p.salaryChangeId!, decision: 'reject', note: 'No' });
		const page = await cyclePage(who.hr, year);
		const ann = page.rows.find((r) => r.id === ids.ann)!;
		expect(ann.proposal!.status).toBe('rejected');
		expect(ann.canEdit).toBe(true);
		expect(page.budgets.map((b) => b.id)).toEqual([dept.Operations]);
		await propose(who.hr, { cycleId: year, employeeId: ids.ann, pct: '6', reason: 'Second try' });
		expect(await proposal(ids.ann, year)).toMatchObject({ status: 'proposed', salaryChangeId: null, changeBp: 600 });
		expect((await applyCycle(who.po, { cycleId: year })).applied).toBe(2);
	});

	it('freezes a closed review', async () => {
		await clearProposal(who.mgr, { cycleId: cycle, employeeId: ids.bob });
		expect(await proposal(ids.bob)).toBeUndefined();
		await closeCycle(who.hr, { cycleId: cycle });
		expect(await code(propose(who.mgr, { cycleId: cycle, employeeId: ids.bob, pct: '3', reason: 'Late' }))).toBe(
			'closed'
		);
		expect(await code(applyCycle(who.po, { cycleId: cycle }))).toBe('closed');
		const page = await cyclePage(who.mgr, cycle);
		expect(page.rows.every((r) => !r.canEdit)).toBe(true);
	});
});
