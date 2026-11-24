import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import {
	employees,
	loanInstalments,
	loans,
	mealBills,
	memberships,
	payComponents,
	payrollRuns,
	taxYears
} from '../../src/lib/server/db/schema';
import { addMonths } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { tenantToday } from '../../src/lib/server/lifecycle';
import { decideLoan } from '../../src/lib/server/loans';
import { voidBill } from '../../src/lib/server/meal-bills';
import { approveRun, payRun, recomputeRun, startRun } from '../../src/lib/server/payroll';
import { closeQueues } from '../../src/lib/server/queue';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { decideSalary, proposeSalary } from '../../src/lib/server/salaries';
import { confirmTaxYear, startTaxYear } from '../../src/lib/server/tax';
import { systemCtx, withTenant, type Tx } from '../../src/lib/server/tenancy';
import { fiscalYearOf } from '../../src/lib/tax';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
let P: string;
const ids: Record<string, string> = {};
const comp: Record<string, string> = {};
const who: Record<string, Member> = {};
const all = () => ({ ...systemCtx(tenant.id), payrollAll: true, salaryAll: true });
const db = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(all(), fn);
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

async function member(key: string, roleKeys: string[], employeeId: string | null, isOwner = false) {
	const u = await createUser();
	const id = await withTenant(systemCtx(tenant.id), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	const access = await loadAccess(tenant.id, { id, status: 'active', employeeId });
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: { ...access, isOwner: isOwner || access.isOwner }
	} as unknown as Member;
}

async function pay(employeeId: string, from: string, basic: string) {
	const changeId = await proposeSalary(who.po, {
		employeeId,
		effectiveFrom: from,
		reason: 'Offer',
		[`c_${comp.BASIC}`]: basic
	});
	await decideSalary(who.fin, { changeId, decision: 'approve', note: '' });
}

beforeAll(async () => {
	tenant = await createTenant('atkpay');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
	P = addMonths((await withTenant(systemCtx(tenant.id), tenantToday)).slice(0, 7), -1);
	ids.ana = await hire('Ana');
	ids.dan = await hire('Dan');
	ids.gone = await hire('Gone');
	await member('po', ['payroll_officer'], null);
	await member('fin', ['finance'], null);
	await member('adm', ['hr_admin'], null);
	await member('mm', ['meal_manager'], null);
	await db(async (tx) => {
		for (const c of await tx.select().from(payComponents)) comp[c.code] = c.id;
	});
	await pay(ids.ana, '2026-01-01', '60000');
	await pay(ids.dan, '2026-01-01', '20000');
	await pay(ids.gone, '2026-01-01', '20000');
	await startTaxYear(who.adm, { fy: fiscalYearOf(`${P}-01`) });
	const [year] = await db((tx) =>
		tx
			.select()
			.from(taxYears)
			.where(eq(taxYears.fy, fiscalYearOf(`${P}-01`)))
	);
	await confirmTaxYear(who.adm, { taxYearId: year.id });
});

afterAll(async () => {
	await closeQueues();
	await closePools();
});

describe('payroll claims and approval order', () => {
	it('refuses to void a meal bill that an approved run already deducts', async () => {
		const [bill] = await db((tx) =>
			tx
				.insert(mealBills)
				.values({
					tenantId: tenant.id,
					employeeId: ids.dan,
					period: addMonths(P, -1),
					status: 'issued',
					billingMode: 'payroll',
					total: 150_000
				})
				.returning({ id: mealBills.id })
		);
		const runId = await startRun(who.po, { period: P });
		await approveRun(who.fin, { runId });
		await expect(voidBill(who.mm, { billId: bill.id })).rejects.toMatchObject({ code: 'claimed' });
		await payRun(who.fin, { runId });
		const [after] = await db((tx) => tx.select().from(mealBills).where(eq(mealBills.id, bill.id)));
		expect([after.status, after.payrollRunId]).toEqual(['deducted', runId]);
	});

	it('approves months in order so year-to-date tax sees every earlier month', async () => {
		const earlyRun = await startRun(who.po, { period: addMonths(P, -1) });
		const lateRun = await startRun(who.po, { period: addMonths(P, 1) });
		await expect(approveRun(who.fin, { runId: lateRun })).rejects.toMatchObject({ code: 'earlier_open' });
		await approveRun(who.fin, { runId: earlyRun });
		await expect(approveRun(who.fin, { runId: lateRun })).rejects.toMatchObject({ code: 'inputs_changed' });
		await recomputeRun(who.po, { runId: lateRun });
		await approveRun(who.fin, { runId: lateRun });
		const status = await db((tx) =>
			tx.select({ status: payrollRuns.status }).from(payrollRuns).where(eq(payrollRuns.id, lateRun))
		);
		expect(status).toEqual([{ status: 'approved' }]);
	});

	it('refuses to approve a loan for someone who has left', async () => {
		const [loan] = await db((tx) =>
			tx
				.insert(loans)
				.values({
					tenantId: tenant.id,
					employeeId: ids.gone,
					kind: 'loan',
					amount: 100_000,
					instalments: 2,
					startPeriod: addMonths(P, 2),
					reason: 'Rent',
					status: 'requested',
					requestedByUserId: who.po.user.userId
				})
				.returning({ id: loans.id })
		);
		await db((tx) =>
			tx
				.update(employees)
				.set({ status: 'exited', exitDate: `${addMonths(P, -3)}-10` })
				.where(eq(employees.id, ids.gone))
		);
		await expect(decideLoan(who.fin, { loanId: loan.id, decision: 'approve', note: '' })).rejects.toMatchObject({
			code: 'exited'
		});
		expect(await db((tx) => tx.select().from(loanInstalments).where(eq(loanInstalments.loanId, loan.id)))).toEqual([]);
		await decideLoan(who.fin, { loanId: loan.id, decision: 'reject', note: 'Left' });
		const [l] = await db((tx) => tx.select({ status: loans.status }).from(loans).where(eq(loans.id, loan.id)));
		expect(l.status).toBe('rejected');
	});
});
