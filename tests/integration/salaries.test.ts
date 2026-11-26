import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFiles, openFile } from '../../src/lib/server/attachments';
import { closePools } from '../../src/lib/server/db';
import { pgCode } from '../../src/lib/server/db/errors';
import {
	employeeSalaries,
	employeeSalaryLines,
	employees,
	memberships,
	payComponents,
	salaryChanges,
	tenantSettings
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import {
	decideSalary,
	proposeSalary,
	resolveLines,
	salaryApprovals,
	salaryBoard,
	salaryCtx
} from '../../src/lib/server/salaries';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const comp: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const sal = () => ({ ...sys(), salaryAll: true });
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const pdf = (name: string) => new File([`%PDF-1.7 ${name}`], name, { type: 'application/pdf' });
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (fullName: string, joinDate = '2026-01-01') =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate
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

const offer = (employeeId: string, effectiveFrom: string, basic: string, extra: Record<string, string> = {}) => ({
	employeeId,
	effectiveFrom,
	reason: 'Offer',
	[`c_${comp.BASIC}`]: basic,
	...extra
});
const decide = (key: string, changeId: string, decision = 'approve') =>
	decideSalary(who[key], { changeId, decision, note: '' });
const salaries = (employeeId: string) =>
	withTenant(sal(), (tx) =>
		tx
			.select({
				from: employeeSalaries.effectiveFrom,
				to: employeeSalaries.effectiveTo,
				gross: employeeSalaries.gross
			})
			.from(employeeSalaries)
			.where(eq(employeeSalaries.employeeId, employeeId))
			.orderBy(employeeSalaries.effectiveFrom)
	);

beforeAll(async () => {
	tenant = await createTenant('salaries');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.ana = await hire('Ana');
	ids.ben = await hire('Ben', '2026-03-01');
	ids.fin = await hire('Fin');
	ids.gone = await hire('Gone');
	await member('ana', ['employee'], ids.ana);
	await member('po', ['payroll_officer'], null);
	await member('fin', ['finance', 'employee'], ids.fin);
	await member('both', ['payroll_officer', 'finance'], null);
	await withTenant(sys(), async (tx) => {
		await tx.update(employees).set({ status: 'exited', exitDate: '2026-02-01' }).where(eq(employees.id, ids.gone));
		await tx.insert(payComponents).values({ tenantId: tenant.id, code: 'UNION', name: 'Union fee', kind: 'deduction' });
		for (const c of await tx.select().from(payComponents)) comp[c.code] = c.id;
	});
});

afterAll(closePools);

describe('salaries', () => {
	it('works out component amounts from basic and adds earnings into gross', () => {
		const components = [
			{ id: 'b', code: 'BASIC', calc: 'fixed', kind: 'earning', name: 'Basic' },
			{ id: 'h', code: 'HOUSE_RENT', calc: 'pct_basic', kind: 'earning', name: 'House rent' },
			{ id: 'u', code: 'UNION', calc: 'fixed', kind: 'deduction', name: 'Union' }
		];
		const values = new Map([
			['b', 3_333_333],
			['h', 3333],
			['u', 10_000]
		]);
		expect(resolveLines(components, values)).toEqual({
			lines: [
				{ componentId: 'b', value: 3_333_333, amount: 3_333_333 },
				{ componentId: 'h', value: 3333, amount: 1_111_000 },
				{ componentId: 'u', value: 10_000, amount: 10_000 }
			],
			gross: 4_444_333
		});
		expect(() => resolveLines(components, new Map([['h', 5000]]))).toThrow('Enter the basic salary.');
	});

	it('lets a payroll officer propose a salary that finance approves, never the same person', async () => {
		const first = await proposeSalary(
			who.po,
			offer(ids.ana, '2026-01-01', '50000', {
				[`c_${comp.HOUSE_RENT}`]: '50',
				[`c_${comp.MEDICAL}`]: '2000.50',
				[`c_${comp.CONVEYANCE}`]: '0',
				[`c_${comp.UNION}`]: '100',
				[`c_${comp.TAX}`]: '999'
			})
		);
		const [change] = await withTenant(sal(), (tx) =>
			tx.select().from(salaryChanges).where(eq(salaryChanges.id, first))
		);
		expect(change).toMatchObject({ status: 'pending', gross: 7_700_050 });
		expect(change.lines.map((l) => [l.componentId, l.amount])).toEqual(
			expect.arrayContaining([
				[comp.BASIC, 5_000_000],
				[comp.HOUSE_RENT, 2_500_000],
				[comp.MEDICAL, 200_050],
				[comp.UNION, 10_000]
			])
		);
		expect(change.lines).toHaveLength(4);
		expect(await code(proposeSalary(who.po, offer(ids.ana, '2026-02-01', '1')))).toBe('pending_exists');
		const [letter] = await addFiles(who.po, 'salary_change', first, [pdf('appraisal.pdf')]);
		expect((await openFile(who.fin, letter)).fileName).toBe('appraisal.pdf');
		expect(await code(openFile(who.ana, letter))).toBe('not_found');
		expect(await code(addFiles(who.fin, 'salary_change', first, [pdf('x.pdf')]))).toBe('forbidden');
		expect(
			(await withTenant(salaryCtx(who.fin), (tx) => salaryApprovals(tx, who.fin.access))).map((a) => a.id)
		).toEqual([first]);
		expect(await withTenant(salaryCtx(who.po), (tx) => salaryApprovals(tx, who.po.access))).toEqual([]);
		expect(await code(decide('po', first))).toBe('not_found');
		expect(await code(decide('ana', first))).toBe('not_found');
		expect(await decide('fin', first)).toBe('approved');
		expect(await code(decide('fin', first))).toBe('decided');
		expect(await code(addFiles(who.po, 'salary_change', first, [pdf('late.pdf')]))).toBe('forbidden');
		expect((await openFile(who.po, letter)).fileName).toBe('appraisal.pdf');
		expect(await salaries(ids.ana)).toEqual([{ from: '2026-01-01', to: null, gross: 7_700_050 }]);
		const lines = await withTenant(sal(), (tx) =>
			tx.select().from(employeeSalaryLines).where(eq(employeeSalaryLines.employeeId, ids.ana))
		);
		expect(lines).toHaveLength(4);

		expect(await code(proposeSalary(who.po, offer(ids.ana, '2026-01-01', '60000')))).toBe('not_after');
		const raise = await proposeSalary(who.po, offer(ids.ana, '2026-07-01', '60000'));
		expect(await decide('fin', raise)).toBe('approved');
		expect(await salaries(ids.ana)).toEqual([
			{ from: '2026-01-01', to: '2026-06-30', gross: 7_700_050 },
			{ from: '2026-07-01', to: null, gross: 6_000_000 }
		]);

		const own = await proposeSalary(who.both, offer(ids.ben, '2026-03-01', '40000'));
		expect(await code(decide('both', own))).toBe('own_change');
		const fins = await proposeSalary(who.po, offer(ids.fin, '2026-01-01', '90000'));
		expect(
			(await withTenant(salaryCtx(who.fin), (tx) => salaryApprovals(tx, who.fin.access))).map((a) => a.id)
		).toEqual([own]);
		const decidable = async (key: string) =>
			(await withTenant(salaryCtx(who[key]), (tx) => salaryBoard(tx, who[key]))).pending.map((c) => [
				c.name,
				c.canDecide
			]);
		expect(await decidable('fin')).toEqual([
			['Ben', true],
			['Fin', false]
		]);
		expect(await decidable('po')).toEqual([
			['Ben', false],
			['Fin', false]
		]);
		expect(await decidable('both')).toEqual([
			['Ben', false],
			['Fin', true]
		]);
		expect(await code(decide('fin', fins))).toBe('own_change');
		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ allowSingleAdminApproval: true }));
		expect(await decide('both', own)).toBe('approved');
		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ allowSingleAdminApproval: false }));
		expect(await decide('both', fins, 'reject')).toBe('rejected');
		expect(await salaries(ids.fin)).toEqual([]);
	});

	it('refuses salaries that start too early, for leavers, or without a basic', async () => {
		expect(await code(proposeSalary(who.po, offer(ids.ben, '2026-03-01', '1')))).toBe('not_after');
		expect(await code(proposeSalary(who.po, offer(ids.fin, '2025-12-31', '1')))).toBe('before_join');
		expect(await code(proposeSalary(who.po, offer(ids.gone, '2026-01-01', '1')))).toBe('exited');
		expect(await code(proposeSalary(who.po, offer(ids.fin, '2026-01-01', '')))).toBe('no_basic');
		expect(await code(proposeSalary(who.po, offer(ids.fin, '2026-01-01', '0')))).toBe('no_basic');
		expect(
			await code(proposeSalary(who.po, offer(ids.fin, '2026-01-01', '100', { [`c_${comp.HOUSE_RENT}`]: '100.01' })))
		).toBe('invalid');
		expect(await code(proposeSalary(who.po, offer(ids.fin, '2026-01-01', '1.234')))).toBe('invalid');
		expect(await code(proposeSalary(who.fin, offer(ids.ana, '2026-09-01', '1')))).toBe('not_found');
		expect(await code(proposeSalary(who.po, offer('not-an-id', '2026-09-01', '1')))).toBe('invalid');
		const active = (code: string, on: boolean) =>
			withTenant(sys(), (tx) => tx.update(payComponents).set({ active: on }).where(eq(payComponents.code, code)));
		await active('CONVEYANCE', false);
		const late = await proposeSalary(
			who.po,
			offer(ids.fin, '2026-01-01', '100', { [`c_${comp.CONVEYANCE}`]: '5', [`c_${comp.MEDICAL}`]: '7' })
		);
		const [pending] = await withTenant(sal(), (tx) =>
			tx.select().from(salaryChanges).where(eq(salaryChanges.id, late))
		);
		expect(pending.lines.map((l) => l.componentId)).toEqual([comp.BASIC, comp.MEDICAL]);
		await active('MEDICAL', false);
		expect(await code(decide('both', late))).toBe('component_gone');
		await active('MEDICAL', true);
		await active('CONVEYANCE', true);
		expect(await decide('both', late, 'reject')).toBe('rejected');
	});

	it('shows salaries only to salary readers and to each employee for their own row', async () => {
		const board = await withTenant(salaryCtx(who.po), (tx) => salaryBoard(tx, who.po));
		expect(board.people.map((p) => [p.name, p.salary?.gross ?? null])).toEqual([
			['Ana', 6_000_000],
			['Ben', 4_000_000],
			['Fin', null]
		]);
		expect(board.components.map((c) => c.code)).toEqual(['BASIC', 'CONVEYANCE', 'HOUSE_RENT', 'MEDICAL', 'UNION']);
		const seen = (employeeId: string | null) =>
			withTenant({ tenantId: tenant.id, employeeId, actor: 'user' }, (tx) =>
				tx.select({ employeeId: employeeSalaries.employeeId }).from(employeeSalaries)
			);
		expect(new Set((await seen(ids.ana)).map((r) => r.employeeId))).toEqual(new Set([ids.ana]));
		expect(await seen(null)).toEqual([]);
		const overlap = withTenant(sal(), async (tx) => {
			const [c] = await tx
				.insert(salaryChanges)
				.values({
					tenantId: tenant.id,
					employeeId: ids.ana,
					effectiveFrom: '2026-08-01',
					reason: 'x',
					status: 'approved',
					lines: [],
					gross: 1,
					requestedByUserId: who.po.user.userId
				})
				.returning();
			await tx
				.insert(employeeSalaries)
				.values({ tenantId: tenant.id, employeeId: ids.ana, effectiveFrom: '2026-08-01', gross: 1, changeId: c.id });
		});
		expect(await overlap.then(() => 'ok').catch(pgCode)).toBe('23P01');
	});
});
