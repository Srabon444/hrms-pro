import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roundTaka } from '../../src/lib/payroll';
import { closePools } from '../../src/lib/server/db';
import {
	assetAssignments,
	assets,
	auditLog,
	attendanceDays,
	attendanceRequests,
	employees,
	employeeSalaries,
	employeeSalaryLines,
	employeeTaxProfiles,
	expenseClaims,
	holidays,
	leaveLedger,
	leaveRequestDays,
	leaveRequests,
	leaveTypes,
	loanInstalments,
	loans,
	mealBills,
	memberships,
	payComponents,
	payrollRuns,
	payslipLines,
	payslips,
	taxSlabs,
	taxYears,
	tenantSettings
} from '../../src/lib/server/db/schema';
import { addMonths } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { tenantToday } from '../../src/lib/server/lifecycle';
import { periodRange } from '../../src/lib/server/meal-bills';
import {
	approveRun,
	myPayslips,
	openPayslipPdf,
	payrollApprovals,
	payrollBoard,
	payRun,
	recomputeRun,
	reopenRun,
	startRun,
	voidRun
} from '../../src/lib/server/payroll';
import { exportPayroll } from '../../src/lib/server/payroll-exports';
import { closeQueues, queue } from '../../src/lib/server/queue';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { decideSalary, proposeSalary } from '../../src/lib/server/salaries';
import { confirmTaxYear, startTaxYear, taxRule } from '../../src/lib/server/tax';
import { systemCtx, withTenant, type Tx } from '../../src/lib/server/tenancy';
import { annualTax, fiscalYearOf } from '../../src/lib/tax';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
let P: string;
const ids: Record<string, string> = {};
const comp: Record<string, string> = {};
const who: Record<string, Member> = {};
const emails: Record<string, string> = {};
const all = () => ({ ...systemCtx(tenant.id), payrollAll: true, salaryAll: true });
const db = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(all(), fn);
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
	emails[key] = u.email;
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

async function pay(employeeId: string, from: string, basic: string, extra: Record<string, string> = {}) {
	const changeId = await proposeSalary(who.po, {
		employeeId,
		effectiveFrom: from,
		reason: 'Offer',
		[`c_${comp.BASIC}`]: basic,
		...extra
	});
	await decideSalary(who.fin, { changeId, decision: 'approve', note: '' });
}

const slipOf = async (runId: string, employeeId: string) => {
	const [s] = await db((tx) =>
		tx
			.select()
			.from(payslips)
			.where(and(eq(payslips.runId, runId), eq(payslips.employeeId, employeeId)))
	);
	const lines = await db((tx) => tx.select().from(payslipLines).where(eq(payslipLines.payslipId, s.id)));
	return { ...s, amounts: Object.fromEntries(lines.map((l) => [l.code, l.amount])) };
};

beforeAll(async () => {
	tenant = await createTenant('payroll');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
	P = addMonths((await withTenant(systemCtx(tenant.id), tenantToday)).slice(0, 7), -1);
	ids.ana = await hire('Ana');
	ids.ben = await hire('Ben', `${P}-16`);
	ids.cal = await hire('Cal');
	await member('ana', ['employee'], ids.ana);
	await member('po', ['payroll_officer'], null);
	await member('fin', ['finance'], null);
	await member('both', ['payroll_officer', 'finance'], null);
	await member('owner', ['finance'], null, true);
	await member('adm', ['hr_admin'], null);
	await db(async (tx) => {
		for (const c of await tx.select().from(payComponents)) comp[c.code] = c.id;
	});
	await pay(ids.ana, '2026-01-01', '30000', { [`c_${comp.HOUSE_RENT}`]: '50' });
	await pay(ids.ben, `${P}-16`, '20000');
	await pay(ids.cal, '2026-01-01', '10000');
	for (const fy of new Set([0, 1, 2, 3].map((n) => fiscalYearOf(`${addMonths(P, -n)}-01`))))
		await startTaxYear(who.adm, { fy });
});

afterAll(async () => {
	await closeQueues();
	await closePools();
});

describe('payroll runs', () => {
	it('computes pay, needs a second person and confirmed tax to approve, and settles everything when paid', async () => {
		await db(async (tx) => {
			await tx.insert(expenseClaims).values({
				tenantId: tenant.id,
				employeeId: ids.ana,
				title: 'Taxi',
				status: 'approved',
				total: 250_000,
				payVia: 'payroll',
				submittedByUserId: who.po.user.userId
			});
			await tx.insert(mealBills).values({
				tenantId: tenant.id,
				employeeId: ids.ana,
				period: addMonths(P, -1),
				status: 'issued',
				billingMode: 'payroll',
				total: 150_000
			});
			const [loan] = await tx
				.insert(loans)
				.values({
					tenantId: tenant.id,
					employeeId: ids.ana,
					kind: 'advance',
					amount: 100_000,
					instalments: 1,
					startPeriod: P,
					reason: 'Rent',
					status: 'approved',
					requestedByUserId: who.po.user.userId
				})
				.returning({ id: loans.id });
			await tx.insert(loanInstalments).values({
				tenantId: tenant.id,
				loanId: loan.id,
				employeeId: ids.ana,
				period: P,
				amount: 100_000
			});
			await tx
				.insert(attendanceDays)
				.values({ tenantId: tenant.id, employeeId: ids.ben, date: `${P}-20`, status: 'absent' });
		});
		expect(await code(startRun(who.fin, { period: P }))).toBe('forbidden');
		expect(await code(startRun(who.po, { period: addMonths(P, 2) }))).toBe('future');
		const runId = await startRun(who.po, { period: P });
		expect(await code(startRun(who.po, { period: P }))).toBe('exists');

		const ana = await slipOf(runId, ids.ana);
		expect(ana.amounts).toEqual({
			BASIC: 3_000_000,
			HOUSE_RENT: 1_500_000,
			EXPENSE: 250_000,
			LOAN: 100_000,
			MEAL: 150_000
		});
		expect([ana.gross, ana.deductions, ana.net, ana.error]).toEqual([4_750_000, 250_000, 4_500_000, null]);
		const dim = Number(periodRange(P).to.slice(8));
		const basic = Math.round((2_000_000 * (dim - 15)) / dim);
		const lop = Math.round(2_000_000 / dim);
		const ben = await slipOf(runId, ids.ben);
		expect(ben.amounts).toEqual({ BASIC: basic, LOP: lop });
		expect([ben.paidDays, ben.unpaidDays, ben.net]).toEqual([dim - 15, 1, roundTaka(basic - lop)]);

		expect(await code(approveRun(who.po, { runId }))).toBe('forbidden');
		expect(await code(approveRun(who.fin, { runId }))).toBe('tax_unconfirmed');
		const [year] = await db((tx) =>
			tx
				.select()
				.from(taxYears)
				.where(eq(taxYears.fy, fiscalYearOf(`${P}-01`)))
		);
		await confirmTaxYear(who.adm, { taxYearId: year.id });
		expect(
			(await withTenant(systemCtx(tenant.id), (tx) => payrollApprovals(tx, who.fin.access))).map((a) => a.title)
		).toEqual([`Payroll for ${P}`]);
		expect(await withTenant(systemCtx(tenant.id), (tx) => payrollApprovals(tx, who.po.access))).toEqual([]);
		expect(await code(payRun(who.fin, { runId }))).toBe('locked');
		await db((tx) => tx.update(tenantSettings).set({ currency: 'USD' }));
		await approveRun(who.fin, { runId });
		expect(await code(approveRun(who.fin, { runId }))).toBe('locked');
		expect(await code(recomputeRun(who.po, { runId }))).toBe('locked');
		expect(await code(voidRun(who.po, { runId }))).toBe('locked');

		const claimed = await db(async (tx) => ({
			expense: (await tx.select().from(expenseClaims).where(eq(expenseClaims.employeeId, ids.ana)))[0],
			meal: (await tx.select().from(mealBills).where(eq(mealBills.employeeId, ids.ana)))[0],
			instalment: (await tx.select().from(loanInstalments).where(eq(loanInstalments.employeeId, ids.ana)))[0]
		}));
		expect([claimed.expense.payrollRunId, claimed.meal.payrollRunId, claimed.instalment.payrollRunId]).toEqual([
			runId,
			runId,
			runId
		]);

		expect(await code(reopenRun(who.fin, { runId }))).toBe('owner_only');
		await reopenRun(who.owner, { runId });
		const released = await db((tx) => tx.select().from(mealBills).where(eq(mealBills.employeeId, ids.ana)));
		expect(released[0].payrollRunId).toBeNull();
		expect(await code(approveRun(who.fin, { runId }))).toBe('ok');

		await payRun(who.fin, { runId });
		const settled = await db(async (tx) => ({
			run: (await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId)))[0],
			expense: (await tx.select().from(expenseClaims).where(eq(expenseClaims.employeeId, ids.ana)))[0],
			meal: (await tx.select().from(mealBills).where(eq(mealBills.employeeId, ids.ana)))[0],
			instalment: (await tx.select().from(loanInstalments).where(eq(loanInstalments.employeeId, ids.ana)))[0],
			loan: (await tx.select().from(loans).where(eq(loans.employeeId, ids.ana)))[0]
		}));
		expect([
			settled.run.status,
			settled.expense.status,
			settled.meal.status,
			settled.instalment.status,
			settled.loan.status
		]).toEqual(['paid', 'paid', 'deducted', 'paid', 'closed']);
		expect(settled.expense.paidByUserId).toBe(who.fin.user.userId);
		expect(await code(payRun(who.fin, { runId }))).toBe('locked');
		expect(await code(reopenRun(who.owner, { runId }))).toBe('locked');

		const mail = (await queue('mail').getJob(`payslip-mail-${ana.id}`))!.data;
		expect([mail.to, mail.subject]).toEqual([emails.ana, `Your payslip for ${P}`]);
		expect(mail.text).toContain(`/t/${tenant.slug}/payslips`);
		expect(mail.text).not.toContain('৳');
		expect(await myPayslips(who.ana)).toEqual([{ id: ana.id, period: P, name: null, net: 4_500_000, currency: 'BDT' }]);
		await db((tx) => tx.update(tenantSettings).set({ currency: 'BDT' }));
		expect(await myPayslips(who.fin)).toEqual([]);
		const pdf = await openPayslipPdf(who.ana, ana.id);
		expect([pdf.fileName, Buffer.from(pdf.body).toString('latin1').slice(0, 5)]).toEqual([`payslip-${P}.pdf`, '%PDF-']);
		expect(await code(openPayslipPdf(who.ana, ben.id))).toBe('not_found');
		expect(await code(openPayslipPdf(who.fin, ana.id))).toBe('not_found');
		expect(await code(openPayslipPdf(who.ana, 'nope'))).toBe('not_found');
	});

	it('refuses approval from the person who computed the run unless they are the only admin', async () => {
		const runId = await startRun(who.both, { period: addMonths(P, -1) });
		expect(await code(approveRun(who.both, { runId }))).toBe('own_run');
		await voidRun(who.both, { runId });
		expect((await db((tx) => tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId))))[0].status).toBe('void');
		const again = await startRun(who.both, { period: addMonths(P, -1) });
		expect(again).not.toBe(runId);
		await voidRun(who.both, { runId: again });
	});

	it('refuses approval when any payroll input or a stored payslip changes after compute', async () => {
		const period = addMonths(P, -2);
		const [year] = await db((tx) =>
			tx
				.select()
				.from(taxYears)
				.where(eq(taxYears.fy, fiscalYearOf(`${period}-01`)))
		);
		await confirmTaxYear(who.adm, { taxYearId: year.id });
		const runId = await startRun(who.po, { period });
		const [anaLine] = await db((tx) =>
			tx
				.select()
				.from(employeeSalaryLines)
				.where(and(eq(employeeSalaryLines.employeeId, ids.ana), eq(employeeSalaryLines.componentId, comp.BASIC)))
		);
		const [slab] = await db((tx) => tx.select().from(taxSlabs).where(eq(taxSlabs.taxYearId, year.id)).limit(1));
		const mutations: [string, (tx: Tx) => Promise<unknown>][] = [
			[
				'salary',
				(tx) => tx.update(employeeSalaryLines).set({ amount: 3_100_000 }).where(eq(employeeSalaryLines.id, anaLine.id))
			],
			[
				'absence',
				(tx) =>
					tx
						.insert(attendanceDays)
						.values({ tenantId: tenant.id, employeeId: ids.cal, date: `${period}-05`, status: 'absent' })
			],
			[
				'late',
				(tx) =>
					tx
						.insert(attendanceDays)
						.values({ tenantId: tenant.id, employeeId: ids.cal, date: `${period}-06`, status: 'late', lateMinutes: 20 })
			],
			[
				'overtime',
				(tx) =>
					tx.insert(attendanceRequests).values({
						tenantId: tenant.id,
						employeeId: ids.cal,
						kind: 'overtime',
						date: `${period}-07`,
						minutes: 60,
						approvedMinutes: 60,
						reason: 'Release',
						status: 'approved',
						requestedByUserId: who.po.user.userId
					})
			],
			[
				'expense',
				(tx) =>
					tx.insert(expenseClaims).values({
						tenantId: tenant.id,
						employeeId: ids.cal,
						title: 'Bus',
						status: 'approved',
						total: 10_000,
						payVia: 'payroll',
						submittedByUserId: who.po.user.userId
					})
			],
			[
				'meal',
				(tx) =>
					tx.insert(mealBills).values({
						tenantId: tenant.id,
						employeeId: ids.cal,
						period: addMonths(period, -1),
						status: 'issued',
						billingMode: 'payroll',
						total: 5_000
					})
			],
			[
				'tax profile',
				(tx) =>
					tx.insert(employeeTaxProfiles).values({
						tenantId: tenant.id,
						taxYearId: year.id,
						employeeId: ids.cal,
						category: 'disabled',
						rebate: 100
					})
			],
			[
				'tax slab',
				(tx) =>
					tx
						.update(taxSlabs)
						.set({ rateBp: slab.rateBp + 1 })
						.where(eq(taxSlabs.id, slab.id))
			],
			['settings', (tx) => tx.update(tenantSettings).set({ pfEmployeeRateBp: 500 })],
			['holiday', (tx) => tx.insert(holidays).values({ tenantId: tenant.id, date: `${period}-10`, name: 'Festival' })],
			[
				'exit',
				(tx) =>
					tx
						.update(employees)
						.set({ exitDate: `${period}-25` })
						.where(eq(employees.id, ids.cal))
			]
		];
		for (const [name, mutate] of mutations) {
			await db(mutate);
			if (name === 'tax slab') await confirmTaxYear(who.adm, { taxYearId: year.id });
			expect([name, await code(approveRun(who.fin, { runId }))]).toEqual([name, 'inputs_changed']);
			await recomputeRun(who.po, { runId });
		}
		const { id: calSlip } = await slipOf(runId, ids.cal);
		const [line] = await db((tx) => tx.select().from(payslipLines).where(eq(payslipLines.payslipId, calSlip)).limit(1));
		await db((tx) =>
			tx
				.update(payslipLines)
				.set({ amount: line.amount + 1 })
				.where(eq(payslipLines.id, line.id))
		);
		expect(await code(approveRun(who.fin, { runId }))).toBe('output_changed');
		await recomputeRun(who.po, { runId });
		await recomputeRun(who.po, { runId });
		expect(await code(approveRun(who.fin, { runId }))).toBe('ok');
		const cal = await slipOf(runId, ids.cal);
		expect(cal.amounts.OVERTIME).toBeUndefined();
		expect(cal.amounts.PF).toBeGreaterThan(0);
		expect(await code(openPayslipPdf(who.ana, (await slipOf(runId, ids.ana)).id))).toBe('not_found');
	});

	it('blocks approval while a payslip has a problem and keeps payslips private to their owner', async () => {
		await db((tx) => tx.update(tenantSettings).set({ pfEmployeeRateBp: 0 }));
		const period = addMonths(P, -3);
		const fy = fiscalYearOf(`${period}-01`);
		const [year] = await db((tx) => tx.select().from(taxYears).where(eq(taxYears.fy, fy)));
		await confirmTaxYear(who.adm, { taxYearId: year.id });
		const late = await hire('Late');
		await db((tx) =>
			tx
				.update(employees)
				.set({ joinDate: `${period}-01` })
				.where(eq(employees.id, late))
		);
		const runId = await startRun(who.po, { period });
		expect((await slipOf(runId, late)).error).toBe(`No approved salary covers ${period}-01.`);
		expect(await code(approveRun(who.fin, { runId }))).toBe('has_errors');
		const board = await payrollBoard(who.fin, runId);
		expect(board.run!.slips.find((s) => s.employeeId === late)!.error).toContain('No approved salary');
		expect(await code(payrollBoard(who.ana))).toBe('forbidden');
		const own = await withTenant(userCtx(who.ana), (tx) =>
			tx.select({ employeeId: payslips.employeeId }).from(payslips)
		);
		expect(new Set(own.map((s) => s.employeeId))).toEqual(new Set([ids.ana]));
		await voidRun(who.po, { runId });
	});
});

describe('payroll inputs', () => {
	const FY = '2024-25';

	beforeAll(async () => {
		tenant = await createTenant('payroll-inputs');
		await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
		await member('po', ['payroll_officer'], null);
		await member('fin', ['finance'], null);
		await member('adm', ['hr_admin'], null);
		await db(async (tx) => {
			for (const c of await tx.select().from(payComponents)) comp[c.code] = c.id;
		});
		ids.dee = await hire('Dee', '2024-01-01');
		ids.gus = await hire('Gus', '2024-01-01');
		ids.hal = await hire('Hal', '2024-01-01');
		ids.fay = await hire('Fay', '2024-09-01');
		for (const k of ['dee', 'gus', 'hal']) await pay(ids[k], '2024-01-01', '20000');
		await db(async (tx) => {
			await tx.update(employees).set({ exitDate: '2024-07-20' }).where(eq(employees.id, ids.gus));
			await tx.update(tenantSettings).set({
				payrollProrationBasis: 'working',
				latePolicyCount: 2,
				mealPayrollLagMonths: 1,
				overtimeRateBp: 20_000,
				overtimeMonthlyHours: 200,
				pfEmployeeRateBp: 1_000
			});
		});
		const taxYearId = await startTaxYear(who.adm, { fy: FY });
		await confirmTaxYear(who.adm, { taxYearId });
		await db((tx) =>
			tx.insert(employeeTaxProfiles).values({
				tenantId: tenant.id,
				taxYearId,
				employeeId: ids.dee,
				category: 'general',
				prevEmployerIncome: 50_000_000
			})
		);
	});

	it('pays only what belongs to the month and builds tax on the approved year to date', async () => {
		const voided = await startRun(who.po, { period: '2024-07' });
		await voidRun(who.po, { runId: voided });
		const july = await startRun(who.po, { period: '2024-07' });
		await approveRun(who.fin, { runId: july });
		const julySlip = await slipOf(july, ids.dee);
		expect((await slipOf(july, ids.gus)).paidDays).toBeGreaterThan(0);

		const user = who.po.user.userId;
		await db(async (tx) => {
			const at = (date: string, status: string, lateMinutes = 0) => ({
				tenantId: tenant.id,
				employeeId: ids.dee,
				date,
				status,
				lateMinutes
			});
			await tx
				.insert(attendanceDays)
				.values([
					at('2024-08-04', 'absent'),
					at('2024-08-05', 'half_day'),
					at('2024-08-06', 'late', 15),
					at('2024-08-07', 'late', 15)
				]);
			await tx.insert(holidays).values({ tenantId: tenant.id, date: '2024-08-15', name: 'Mourning day' });
			for (const [code, date] of [
				['unpaid', '2024-08-08'],
				['casual', '2024-08-11']
			]) {
				const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.code, code));
				const [req] = await tx
					.insert(leaveRequests)
					.values({
						tenantId: tenant.id,
						employeeId: ids.dee,
						leaveTypeId: type.id,
						startDate: date,
						endDate: date,
						session: 'full',
						days: 1,
						status: 'approved',
						requestedByUserId: user
					})
					.returning({ id: leaveRequests.id });
				await tx.insert(leaveRequestDays).values({
					tenantId: tenant.id,
					requestId: req.id,
					employeeId: ids.dee,
					date,
					session: 'full',
					fiscalYear: 2024,
					status: 'approved'
				});
			}
			const ot = (minutes: number, status: string, date: string) => ({
				tenantId: tenant.id,
				employeeId: ids.dee,
				kind: 'overtime',
				date,
				minutes,
				approvedMinutes: status === 'pending' ? null : minutes,
				reason: 'Release',
				status,
				requestedByUserId: user
			});
			const [, , banked] = await tx
				.insert(attendanceRequests)
				.values([
					ot(120, 'approved', '2024-08-12'),
					ot(600, 'cancelled', '2024-08-13'),
					ot(300, 'approved', '2024-08-14')
				])
				.returning({ id: attendanceRequests.id });
			const [casual] = await tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'casual'));
			await tx.insert(leaveLedger).values({
				tenantId: tenant.id,
				employeeId: ids.dee,
				leaveTypeId: casual.id,
				fiscalYear: 2024,
				kind: 'comp_credit',
				days: 1,
				refId: banked.id
			});
			const claim = (total: number, status: string, payVia: string, payrollRunId: string | null = null) => ({
				tenantId: tenant.id,
				employeeId: ids.dee,
				title: 'Taxi',
				status,
				total,
				payVia,
				payrollRunId,
				submittedByUserId: user
			});
			await tx
				.insert(expenseClaims)
				.values([
					claim(300_000, 'approved', 'payroll'),
					claim(1_000, 'submitted', 'payroll'),
					claim(2_000, 'approved', 'direct'),
					claim(4_000, 'approved', 'payroll', voided)
				]);
			const bill = (period: string, status: string, billingMode: string, total: number) => ({
				tenantId: tenant.id,
				employeeId: ids.dee,
				period,
				status,
				billingMode,
				total
			});
			await tx
				.insert(mealBills)
				.values([
					bill('2024-07', 'issued', 'payroll', 200_000),
					bill('2024-05', 'draft', 'payroll', 7_000),
					bill('2024-06', 'issued', 'direct', 8_000),
					bill('2024-08', 'issued', 'payroll', 9_000)
				]);
			const [loan] = await tx
				.insert(loans)
				.values({
					tenantId: tenant.id,
					employeeId: ids.dee,
					kind: 'loan',
					amount: 300_000,
					instalments: 3,
					startPeriod: '2024-07',
					reason: 'Rent',
					status: 'approved',
					requestedByUserId: user
				})
				.returning({ id: loans.id });
			const due = (period: string, status: string) => ({
				tenantId: tenant.id,
				loanId: loan.id,
				employeeId: ids.dee,
				period,
				amount: 100_000,
				status
			});
			await tx.insert(loanInstalments).values([due('2024-07', 'paid'), due('2024-08', 'due'), due('2024-09', 'due')]);
			const [final] = await tx
				.insert(payrollRuns)
				.values({
					tenantId: tenant.id,
					runType: 'final',
					period: '2024-08',
					employeeId: ids.hal,
					status: 'approved',
					inputsHash: '',
					outputHash: '',
					computedByUserId: user,
					computedAt: new Date()
				})
				.returning({ id: payrollRuns.id });
			await tx.insert(payslips).values({
				tenantId: tenant.id,
				runId: final.id,
				employeeId: ids.hal,
				paidDays: 0,
				unpaidDays: 0,
				gross: 0,
				deductions: 0,
				rounding: 0,
				net: 0,
				taxable: 0,
				tax: 0
			});
		});

		expect(await code(approveRun(who.fin, { runId: crypto.randomUUID() }))).toBe('not_found');
		const august = await startRun(who.po, { period: '2024-08' });
		const slips = await db((tx) => tx.select().from(payslips).where(eq(payslips.runId, august)));
		expect(slips.map((s) => s.employeeId)).toEqual([ids.dee]);
		const dee = await slipOf(august, ids.dee);
		const taxable = 2_000_000 + 40_000 - 350_000;
		const rule = (await db((tx) => taxRule(tx, FY, 'general')))!;
		const tax = Math.max(
			0,
			Math.round((annualTax(50_000_000 + julySlip.taxable + taxable * 11, 0, rule) - julySlip.tax) / 11)
		);
		expect(tax).toBeGreaterThan(0);
		expect(dee.amounts).toEqual({
			BASIC: 2_000_000,
			LOP: 350_000,
			OVERTIME: 40_000,
			EXPENSE: 300_000,
			PF: 200_000,
			TAX: tax,
			LOAN: 100_000,
			MEAL: 200_000
		});
		expect([dee.paidDays, dee.unpaidDays, dee.taxable]).toEqual([20, 3.5, taxable]);
		await approveRun(who.fin, { runId: august });
	});
});

describe('bonus runs', () => {
	const FY = '2024-25';

	beforeAll(async () => {
		tenant = await createTenant('payroll-bonus');
		await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
		await member('po', ['payroll_officer'], null);
		await member('fin', ['finance'], null);
		await member('adm', ['hr_admin'], null);
		await db(async (tx) => {
			for (const c of await tx.select().from(payComponents)) comp[c.code] = c.id;
		});
		ids.ivy = await hire('Ivy', '2024-01-01');
		ids.jon = await hire('Jon', '2024-03-15');
		ids.kai = await hire('Kai', '2024-02-29');
		ids.kim = await hire('Kim', '2024-01-01');
		ids.lee = await hire('Lee', '2024-01-01');
		ids.max = await hire('Max', '2024-01-01');
		ids.ned = await hire('Ned', '2024-09-01');
		await member('ivy', ['employee'], ids.ivy);
		await pay(ids.ivy, '2024-01-01', '200000');
		await pay(ids.ivy, '2024-08-31', '300000', { [`c_${comp.HOUSE_RENT}`]: '10' });
		for (const k of ['kim', 'lee']) await pay(ids[k], '2024-01-01', '20000');
		await pay(ids.jon, '2024-03-15', '20000');
		await pay(ids.kai, '2024-02-29', '20000');
		await pay(ids.ned, '2024-09-01', '20000');
		await pay(ids.kai, '2024-09-01', '90000');
		await db(async (tx) => {
			await tx.update(employees).set({ exitDate: '2024-08-30' }).where(eq(employees.id, ids.kim));
			await tx.update(tenantSettings).set({ bonusRateBp: 5_000, bonusMinServiceMonths: 6 });
			const [final] = await tx
				.insert(payrollRuns)
				.values({
					tenantId: tenant.id,
					runType: 'final',
					period: '2024-08',
					employeeId: ids.lee,
					status: 'approved',
					inputsHash: '',
					outputHash: '',
					computedByUserId: who.po.user.userId,
					computedAt: new Date()
				})
				.returning({ id: payrollRuns.id });
			await tx.insert(payslips).values({
				tenantId: tenant.id,
				runId: final.id,
				employeeId: ids.lee,
				paidDays: 0,
				unpaidDays: 0,
				gross: 0,
				deductions: 0,
				rounding: 0,
				net: 0,
				taxable: 0,
				tax: 0
			});
		});
		const taxYearId = await startTaxYear(who.adm, { fy: FY });
		await confirmTaxYear(who.adm, { taxYearId });
	});

	it('pays a percent of basic to people with enough service and withholds its tax in later months', async () => {
		expect(await code(startRun(who.po, { period: '2024-08', runType: 'bonus', title: '  ' }))).toBe(
			'invalid: Name the bonus, like Eid-ul-Fitr bonus.'
		);
		expect(await code(startRun(who.po, { period: '2024-08', runType: 'bonus', title: 'Eid\nbonus' }))).toBe(
			'invalid: The bonus name cannot have line breaks.'
		);
		expect(await code(startRun(who.po, { period: '2024-08', runType: 'nope', title: 'x' }))).toBe(
			'invalid: Choose what to pay.'
		);
		const regular = await startRun(who.po, { period: '2024-08', title: 'ignored' });
		const eid = await startRun(who.po, { period: '2024-08', runType: 'bonus', title: ' Eid-ul-Adha bonus ' });
		const other = await startRun(who.po, { period: '2024-08', runType: 'bonus', title: 'Puja bonus' });
		const [run] = await db((tx) => tx.select().from(payrollRuns).where(eq(payrollRuns.id, eid)));
		expect([run.runType, run.title]).toEqual(['bonus', 'Eid-ul-Adha bonus']);
		expect((await db((tx) => tx.select().from(payrollRuns).where(eq(payrollRuns.id, regular))))[0].title).toBeNull();

		const slips = await db((tx) => tx.select().from(payslips).where(eq(payslips.runId, eid)));
		expect(slips.map((s) => s.employeeId).sort()).toEqual([ids.ivy, ids.kai, ids.max].sort());
		expect((await slipOf(eid, ids.max)).error).toBe('No approved salary on 2024-08-31.');
		expect(await code(approveRun(who.fin, { runId: eid }))).toBe('has_errors');

		await pay(ids.max, '2024-01-01', '10001');
		await recomputeRun(who.po, { runId: eid });
		const ivy = await slipOf(eid, ids.ivy);
		expect(ivy.amounts).toEqual({ BONUS: 15_000_000 });
		expect([ivy.gross, ivy.taxable, ivy.tax, ivy.net, ivy.deductions, ivy.error]).toEqual([
			15_000_000,
			15_000_000,
			0,
			15_000_000,
			0,
			null
		]);
		const max = await slipOf(eid, ids.max);
		expect([max.amounts, max.net, max.rounding]).toEqual([{ BONUS: 500_050 }, 500_100, 50]);
		expect((await slipOf(eid, ids.kai)).amounts).toEqual({ BONUS: 1_000_000 });
		const [line] = await db((tx) => tx.select().from(payslipLines).where(eq(payslipLines.payslipId, ivy.id)));
		expect([line.name, line.kind, line.taxable]).toEqual(['Eid-ul-Adha bonus', 'earning', true]);

		await db((tx) => tx.update(tenantSettings).set({ bonusRateBp: 6_000 }));
		expect(await code(approveRun(who.fin, { runId: eid }))).toBe('inputs_changed');
		await db((tx) => tx.update(tenantSettings).set({ bonusRateBp: 5_000 }));
		await approveRun(who.fin, { runId: eid });
		await payRun(who.fin, { runId: eid });
		expect(
			(await withTenant(systemCtx(tenant.id), (tx) => payrollApprovals(tx, who.fin.access))).map((a) => a.title).sort()
		).toEqual(['Payroll for 2024-08', 'Puja bonus for 2024-08']);
		await db((tx) => tx.update(tenantSettings).set({ bonusRateBp: 0 }));
		const zero = await startRun(who.po, { period: '2024-08', runType: 'bonus', title: 'Zero bonus' });
		expect(await db((tx) => tx.select().from(payslips).where(eq(payslips.runId, zero)))).toEqual([]);
		await voidRun(who.po, { runId: zero });
		await voidRun(who.po, { runId: other });
		await voidRun(who.po, { runId: regular });

		const mail = (await queue('mail').getJob(`payslip-mail-${ivy.id}`))!.data;
		expect([mail.to, mail.subject]).toEqual([emails.ivy, 'Your Eid-ul-Adha bonus payslip for 2024-08']);
		expect(await myPayslips(who.ivy)).toEqual([
			{ id: ivy.id, period: '2024-08', name: 'Eid-ul-Adha bonus', net: 15_000_000, currency: 'BDT' }
		]);
		const pdf = await openPayslipPdf(who.ivy, ivy.id);
		expect(pdf.fileName).toBe('bonus-2024-08.pdf');

		const sep = await startRun(who.po, { period: '2024-09' });
		const sepIvy = await slipOf(sep, ids.ivy);
		const rule = (await db((tx) => taxRule(tx, FY, 'general')))!;
		expect(sepIvy.taxable).toBeGreaterThanOrEqual(30_000_000);
		const tax = Math.round(annualTax(15_000_000 + sepIvy.taxable * 10, 0, rule) / 10);
		expect(tax).toBeGreaterThan(Math.round(annualTax(sepIvy.taxable * 10, 0, rule) / 10));
		expect(sepIvy.amounts.TAX).toBe(tax);
	});
});

describe('arrears runs', () => {
	const finalFor = (employeeId: string, period: string) =>
		db(async (tx) => {
			const [final] = await tx
				.insert(payrollRuns)
				.values({
					tenantId: tenant.id,
					runType: 'final',
					period,
					employeeId,
					status: 'approved',
					inputsHash: '',
					outputHash: '',
					computedByUserId: who.po.user.userId,
					computedAt: new Date()
				})
				.returning({ id: payrollRuns.id });
			await tx.insert(payslips).values({
				tenantId: tenant.id,
				runId: final.id,
				employeeId,
				paidDays: 0,
				unpaidDays: 0,
				gross: 0,
				deductions: 0,
				rounding: 0,
				net: 0,
				taxable: 0,
				tax: 0
			});
		});
	const linesOf = (payslipId: string) =>
		db((tx) => tx.select().from(payslipLines).where(eq(payslipLines.payslipId, payslipId)).orderBy(payslipLines.seq));
	const slipsIn = (runId: string) => db((tx) => tx.select().from(payslips).where(eq(payslips.runId, runId)));
	const approve = async (period: string, form: Record<string, string> = {}) =>
		approveRun(who.fin, { runId: await startRun(who.po, { period, ...form }) });

	beforeAll(async () => {
		tenant = await createTenant('payroll-arrears');
		await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
		await member('po', ['payroll_officer'], null);
		await member('fin', ['finance'], null);
		await member('adm', ['hr_admin'], null);
		await db(async (tx) => {
			for (const c of await tx.select().from(payComponents)) comp[c.code] = c.id;
		});
		ids.opa = await hire('Opa', '2024-01-01');
		ids.pia = await hire('Pia', '2024-01-01');
		ids.quinn = await hire('Quinn', '2024-01-01');
		await member('opa', ['employee'], ids.opa);
		await pay(ids.opa, '2024-01-01', '30000');
		await pay(ids.pia, '2024-01-01', '20000');
		await pay(ids.quinn, '2024-01-01', '20000');
		await db((tx) =>
			tx.update(tenantSettings).set({
				pfEmployeeRateBp: 1_000,
				pfEmployerRateBp: 0,
				arrearsLookbackMonths: 1,
				bonusRateBp: 1_000
			})
		);
		const taxYearId = await startTaxYear(who.adm, { fy: '2024-25' });
		await confirmTaxYear(who.adm, { taxYearId });
		await approve('2024-07');
		ids.rex = await hire('Rex', '2024-07-01');
		await pay(ids.rex, '2024-07-01', '10000');
		await approve('2024-08');
		await approve('2024-08', { runType: 'bonus', title: 'Eid bonus' });
	});

	it('pays salary differences of approved months once, inside the look-back window, under the rules of each month', async () => {
		await db((tx) => tx.update(tenantSettings).set({ pfEmployeeRateBp: 2_000 }));
		await pay(ids.opa, '2024-07-01', '40000');
		await pay(ids.quinn, '2024-07-01', '40000');
		await finalFor(ids.quinn, '2024-08');

		await db((tx) => tx.update(tenantSettings).set({ currency: 'EUR' }));
		const first = await startRun(who.po, { period: '2024-08', runType: 'arrears' });
		await db((tx) => tx.update(tenantSettings).set({ currency: 'BDT' }));
		const second = await startRun(who.po, { period: '2024-08', runType: 'arrears' });
		const [run] = await db((tx) => tx.select().from(payrollRuns).where(eq(payrollRuns.id, first)));
		expect([run.runType, run.title, run.settings, run.currency]).toEqual(['arrears', null, null, 'EUR']);
		expect((await slipsIn(first)).map((s) => s.employeeId)).toEqual([ids.opa]);
		const opa = await slipOf(first, ids.opa);
		const lines = await linesOf(opa.id);
		expect(lines.map((l) => [l.name, l.kind, l.taxable, l.amount, l.forPeriod])).toEqual([
			['Arrears for 2024-07', 'earning', true, 1_000_000, '2024-07'],
			['Provident fund for 2024-07', 'deduction', false, 100_000, '2024-07'],
			['Arrears for 2024-08', 'earning', true, 1_000_000, '2024-08'],
			['Provident fund for 2024-08', 'deduction', false, 100_000, '2024-08']
		]);
		expect([opa.gross, opa.deductions, opa.net, opa.taxable, opa.tax, opa.paidDays]).toEqual([
			2_000_000, 200_000, 1_800_000, 2_000_000, 0, 0
		]);

		await db((tx) => tx.update(payslipLines).set({ forPeriod: '2024-06' }).where(eq(payslipLines.id, lines[0].id)));
		expect(await code(approveRun(who.fin, { runId: first }))).toBe('output_changed');
		await db((tx) => tx.update(payslipLines).set({ forPeriod: '2024-07' }).where(eq(payslipLines.id, lines[0].id)));
		await approveRun(who.fin, { runId: first });
		expect(await code(approveRun(who.fin, { runId: second }))).toBe('inputs_changed');
		await recomputeRun(who.po, { runId: second });
		expect(await slipsIn(second)).toEqual([]);
		await voidRun(who.po, { runId: second });

		await payRun(who.fin, { runId: first });
		const mail = (await queue('mail').getJob(`payslip-mail-${opa.id}`))!.data;
		expect([mail.to, mail.subject]).toEqual([emails.opa, 'Your Salary arrears payslip for 2024-08']);
		expect(await myPayslips(who.opa)).toEqual([
			{ id: opa.id, period: '2024-08', name: 'Salary arrears', net: 1_800_000, currency: 'EUR' }
		]);
		expect((await openPayslipPdf(who.opa, opa.id)).fileName).toBe('arrears-2024-08.pdf');

		const settled = await startRun(who.po, { period: '2024-09', runType: 'arrears' });
		expect(await slipsIn(settled)).toEqual([]);
		await approve('2024-08', { runType: 'bonus', title: 'Puja bonus' });
		await approveRun(who.fin, { runId: settled });

		await db((tx) =>
			tx.update(employeeSalaries).set({ effectiveFrom: '2024-07-05' }).where(eq(employeeSalaries.employeeId, ids.pia))
		);
		const late = await startRun(who.po, { period: '2024-09', runType: 'arrears' });
		expect(await slipsIn(late)).toEqual([]);
		await db((tx) => tx.update(tenantSettings).set({ arrearsLookbackMonths: 2 }));
		await recomputeRun(who.po, { runId: late });
		expect((await slipOf(late, ids.pia)).error).toBe('2024-07: No approved salary covers 2024-07-01.');
		const quinn = await slipOf(late, ids.quinn);
		expect([quinn.net, (await linesOf(quinn.id)).map((l) => l.name)]).toEqual([
			1_800_000,
			['Arrears for 2024-07', 'Provident fund for 2024-07']
		]);
		expect((await slipsIn(late)).length).toBe(2);
		expect(
			(await withTenant(systemCtx(tenant.id), (tx) => payrollApprovals(tx, who.fin.access))).map((a) => a.title)
		).toEqual(['Salary arrears for 2024-09']);
	});
});

describe('final settlement', () => {
	const approve = async (period: string) => approveRun(who.fin, { runId: await startRun(who.po, { period }) });
	const settle = (employeeId: string, form: Record<string, string> = {}) =>
		startRun(who.po, { runType: 'final', employeeId, ...form });
	const leaves = (employeeId: string, exitDate: string | null) =>
		db((tx) => tx.update(employees).set({ exitDate }).where(eq(employees.id, employeeId)));

	beforeAll(async () => {
		tenant = await createTenant('payroll-final');
		await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
		await member('po', ['payroll_officer'], null);
		await member('fin', ['finance'], null);
		await member('adm', ['hr_admin'], null);
		await member('owner', ['finance'], null, true);
		await db(async (tx) => {
			for (const c of await tx.select().from(payComponents)) comp[c.code] = c.id;
		});
		ids.sam = await hire('Sam', '2018-08-01');
		ids.ted = await hire('Ted', '2023-01-01');
		ids.una = await hire('Una', '2024-01-01');
		ids.vic = await hire('Vic', '2024-01-01');
		await member('sam', ['employee'], ids.sam);
		await pay(ids.sam, '2018-08-01', '30000');
		await pay(ids.ted, '2023-01-01', '20000');
		await pay(ids.una, '2024-01-01', '10000');
		await pay(ids.vic, '2024-01-01', '10000');
		await db(async (tx) => {
			await tx.update(tenantSettings).set({ pfEmployeeRateBp: 1_000, pfEmployerRateBp: 1_000, pfVestingMonths: 20 });
			const [earned] = await tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'earned'));
			const [casual] = await tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'casual'));
			const [sick] = await tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'sick'));
			const ledger = (leaveTypeId: string, kind: string, days: number, fiscalYear = 2024) => ({
				tenantId: tenant.id,
				employeeId: ids.sam,
				leaveTypeId,
				fiscalYear,
				kind,
				days
			});
			await tx
				.insert(leaveLedger)
				.values([
					ledger(earned.id, 'accrual', 14),
					ledger(earned.id, 'taken', -2),
					ledger(earned.id, 'accrual', 9, 2023),
					ledger(casual.id, 'accrual', 10),
					ledger(casual.id, 'taken', -10),
					ledger(sick.id, 'accrual', 14)
				]);
			await tx.update(leaveTypes).set({ encashable: true }).where(eq(leaveTypes.id, casual.id));
			const [loan] = await tx
				.insert(loans)
				.values({
					tenantId: tenant.id,
					employeeId: ids.sam,
					kind: 'loan',
					amount: 300_000,
					instalments: 3,
					startPeriod: '2024-08',
					reason: 'Rent',
					status: 'approved',
					requestedByUserId: who.po.user.userId
				})
				.returning({ id: loans.id });
			await tx.insert(loanInstalments).values(
				['2024-08', '2024-09', '2024-10'].map((period) => ({
					tenantId: tenant.id,
					loanId: loan.id,
					employeeId: ids.sam,
					period,
					amount: 100_000
				}))
			);
			await tx.insert(mealBills).values({
				tenantId: tenant.id,
				employeeId: ids.sam,
				period: '2024-08',
				status: 'partially_paid',
				billingMode: 'direct',
				total: 50_000,
				paid: 10_000
			});
		});
		const taxYearId = await startTaxYear(who.adm, { fy: '2024-25' });
		await confirmTaxYear(who.adm, { taxYearId });
		await approve('2024-07');
		await leaves(ids.sam, '2024-08-15');
		await leaves(ids.ted, '2024-08-31');
		await leaves(ids.una, '2024-09-10');
	});

	it('settles a leaver once: the exit month, leave, gratuity, provident fund, notice, assets, loans and meals', async () => {
		expect(await code(settle('nope'))).toBe('invalid: Choose who is leaving.');
		expect(await code(settle(ids.sam, { noticePayDays: '5', noticeShortDays: '5' }))).toBe(
			'invalid: Enter notice paid in lieu or a notice shortfall, not both.'
		);
		expect(await code(settle(ids.sam, { assetDeduction: '1.234' }))).toBe(
			'invalid: Enter the asset deduction, up to 2 decimals.'
		);
		expect(await code(settle(ids.vic))).toBe('no_exit');
		await leaves(ids.vic, '2099-01-31');
		expect(await code(settle(ids.vic))).toBe('future');
		await leaves(ids.vic, null);
		expect(await code(startRun(who.fin, { runType: 'final', employeeId: ids.sam }))).toBe('forbidden');

		const samRun = await settle(ids.sam, { assetDeduction: '1500.50' });
		expect(await code(settle(ids.sam))).toBe('exists');
		const [run] = await db((tx) => tx.select().from(payrollRuns).where(eq(payrollRuns.id, samRun)));
		expect([run.runType, run.period, run.employeeId, run.assetDeduction, run.title]).toEqual([
			'final',
			'2024-08',
			ids.sam,
			150_050,
			null
		]);
		const sam = await slipOf(samRun, ids.sam);
		expect(sam.amounts).toEqual({
			BASIC: 1_451_613,
			PF: 145_161,
			PF_EMPLOYER: 145_161,
			LEAVE_ENCASH: 1_200_000,
			GRATUITY: 18_000_000,
			PF_PAYOUT: 445_161,
			PF_EMPLOYER_PAYOUT: 445_161,
			ASSET: 150_050,
			LOAN: 300_000,
			MEAL: 40_000
		});
		expect([sam.paidDays, sam.taxable, sam.tax, sam.net, sam.error, sam.notes]).toEqual([
			15,
			2_651_613,
			0,
			roundTaka(21_541_935 - 635_211),
			null,
			[]
		]);
		const names = await db((tx) =>
			tx.select({ name: payslipLines.name }).from(payslipLines).where(eq(payslipLines.payslipId, sam.id))
		);
		expect(names.map((n) => n.name)).toContain('Leave encashment: Earned leave (12 days)');

		const august = await startRun(who.po, { period: '2024-08' });
		expect(
			(await db((tx) => tx.select().from(payslips).where(eq(payslips.runId, august)))).map((s) => s.employeeId).sort()
		).toEqual([ids.ted, ids.una, ids.vic].sort());
		await approveRun(who.fin, { runId: august });

		const tedRun = await settle(ids.ted, { noticePayDays: '10' });
		const ted = await slipOf(tedRun, ids.ted);
		expect(ted.amounts).toEqual({ NOTICE_PAY: 666_667, PF_PAYOUT: 400_000, PF_EMPLOYER_PAYOUT: 400_000 });
		expect([ted.paidDays, ted.net, ted.notes]).toEqual([0, 1_466_700, []]);
		expect(await code(reopenRun(who.owner, { runId: august }))).toBe('settled');

		const september = await startRun(who.po, { period: '2024-09' });
		expect(await code(settle(ids.una))).toBe('in_payroll');
		await voidRun(who.po, { runId: september });
		const unaRun = await settle(ids.una);
		const una = await slipOf(unaRun, ids.una);
		expect([una.paidDays, una.amounts, una.notes]).toEqual([
			10,
			{ BASIC: 333_333, PF: 33_333, PF_EMPLOYER: 33_333, PF_PAYOUT: 233_333 },
			['Employer provident fund of 2333.33 is not vested.']
		]);
		await leaves(ids.una, '2024-10-05');
		await recomputeRun(who.po, { runId: unaRun });
		expect((await slipOf(unaRun, ids.una)).error).toBe(
			'The exit date is no longer in 2024-09. Void this run and start a new one.'
		);
		await voidRun(who.po, { runId: unaRun });

		const board = await payrollBoard(who.po, samRun);
		expect(board.leavers.map((l) => l.name)).toEqual(['Una']);
		expect(board.run!.leaver).toBe('Sam');
		expect(
			(await withTenant(systemCtx(tenant.id), (tx) => payrollApprovals(tx, who.fin.access))).map((a) => a.title)
		).toEqual(['Final settlement for 2024-08 · Sam', 'Final settlement for 2024-08 · Ted']);

		await approveRun(who.fin, { runId: samRun });
		await payRun(who.fin, { runId: samRun });
		const after = await db(async (tx) => ({
			instalments: (await tx.select().from(loanInstalments).where(eq(loanInstalments.employeeId, ids.sam))).map(
				(i) => i.status
			),
			loan: (await tx.select().from(loans).where(eq(loans.employeeId, ids.sam)))[0].status,
			meal: (await tx.select().from(mealBills).where(eq(mealBills.employeeId, ids.sam)))[0].status,
			encash: await tx
				.select({ days: leaveLedger.days, fiscalYear: leaveLedger.fiscalYear, refId: leaveLedger.refId })
				.from(leaveLedger)
				.where(and(eq(leaveLedger.employeeId, ids.sam), eq(leaveLedger.kind, 'encash')))
		}));
		expect(after).toEqual({
			instalments: ['paid', 'paid', 'paid'],
			loan: 'closed',
			meal: 'deducted',
			encash: [{ days: -12, fiscalYear: 2024, refId: sam.id }]
		});
		const mail = (await queue('mail').getJob(`payslip-mail-${sam.id}`))!.data;
		expect([mail.to, mail.subject]).toEqual([emails.sam, 'Your Final settlement payslip for 2024-08']);
		expect(await myPayslips(who.sam)).toEqual([
			{ id: sam.id, period: '2024-08', name: 'Final settlement', net: sam.net, currency: 'BDT' }
		]);
		expect((await openPayslipPdf(who.sam, sam.id)).fileName).toBe('final-2024-08.pdf');

		await db(async (tx) => {
			const [laptop] = await tx
				.insert(assets)
				.values({ tenantId: tenant.id, tag: 'LAP-9', name: 'Laptop', category: 'Laptop', status: 'lost' })
				.returning();
			const handout = { tenantId: tenant.id, assetId: laptop.id, employeeId: ids.una, conditionOut: 'good' };
			await tx.insert(assetAssignments).values([
				{ ...handout, assignedOn: '2023-05-01', returnedOn: '2023-06-01', outcome: 'written_off', charge: 99 },
				{ ...handout, assignedOn: '2024-02-01', returnedOn: '2024-09-01', outcome: 'written_off', charge: 25_000 }
			]);
		});
		expect((await payrollBoard(who.po)).leavers.map((l) => [l.name, l.charges])).toEqual([['Una', 25_000]]);
		const charged = await settle(ids.una);
		const runOf = async (id: string) =>
			(await db((tx) => tx.select().from(payrollRuns).where(eq(payrollRuns.id, id))))[0].assetDeduction;
		expect(await runOf(charged)).toBe(25_000);
		await voidRun(who.po, { runId: charged });
		expect(await runOf(await settle(ids.una, { assetDeduction: '0' }))).toBe(0);
	});
});

describe('payroll exports', () => {
	const rows = async (m: Member, runId: string, kind: string) => (await exportPayroll(m, { runId, kind })).rows;

	beforeAll(async () => {
		tenant = await createTenant('payroll-export');
		await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
		await member('po', ['payroll_officer'], null);
		await member('fin', ['finance'], null);
		await member('adm', ['hr_admin'], null);
		await member('cfo', ['finance', 'hr_admin'], null);
		await db(async (tx) => {
			for (const c of await tx.select().from(payComponents)) comp[c.code] = c.id;
		});
		ids.amy = await hire('Amy', '2024-01-01');
		ids.ben = await hire('Ben', '2024-01-01');
		await pay(ids.amy, '2024-01-01', '50000');
		await pay(ids.ben, '2024-01-01', '20000');
		await db(async (tx) => {
			await tx.update(tenantSettings).set({ pfEmployeeRateBp: 1_000, pfEmployerRateBp: 500 });
			await tx
				.update(employees)
				.set({ bankName: 'City Bank', bankAccountName: 'Amy', bankAccountNumber: '=0012345', taxId: '123456789012' })
				.where(eq(employees.id, ids.amy));
		});
		const taxYearId = await startTaxYear(who.adm, { fy: '2024-25' });
		await confirmTaxYear(who.adm, { taxYearId });
	});

	it('downloads the register, PF and tax reports, and the bank sheet once finance approves', async () => {
		const runId = await startRun(who.po, { period: '2024-07' });
		const [amy, ben] = [await slipOf(runId, ids.amy), await slipOf(runId, ids.ben)];
		const codes = await db((tx) =>
			tx.select({ id: employees.id, code: employees.code }).from(employees).orderBy(employees.code)
		);
		const [a, b] = [ids.amy, ids.ben].map((id) => codes.find((c) => c.id === id)!.code);
		expect(a < b).toBe(true);
		const t = (p: number) => (p / 100).toFixed(2);

		expect(await rows(who.po, runId, 'register')).toEqual([
			['Code', 'Name', 'Paid days', 'Unpaid days', 'BASIC', 'Gross', 'PF', 'TAX', 'Deductions', 'Net', 'PF_EMPLOYER'],
			[a, 'Amy', 31, 0, '50000.00', t(amy.gross), '5000.00', t(amy.tax), t(amy.deductions), t(amy.net), '2500.00'],
			[b, 'Ben', 31, 0, '20000.00', t(ben.gross), '2000.00', '0.00', t(ben.deductions), t(ben.net), '1000.00'],
			[
				'Total',
				'',
				'',
				'',
				'70000.00',
				t(amy.gross + ben.gross),
				'7000.00',
				t(amy.tax),
				t(amy.deductions + ben.deductions),
				t(amy.net + ben.net),
				'3500.00'
			]
		]);
		expect(amy.tax).toBeGreaterThan(0);
		expect(ben.tax).toBe(0);
		expect(await rows(who.po, runId, 'pf')).toEqual([
			['Code', 'Name', 'Employee share', 'Employer share', 'Total'],
			[a, 'Amy', '5000.00', '2500.00', '7500.00'],
			[b, 'Ben', '2000.00', '1000.00', '3000.00'],
			['Total', '', '7000.00', '3500.00', '10500.00']
		]);
		expect(await rows(who.fin, runId, 'tax')).toEqual([
			['Code', 'Name', 'Taxable income', 'Tax deducted'],
			[a, 'Amy', t(amy.taxable), t(amy.tax)],
			[b, 'Ben', t(ben.taxable), '0.00'],
			['Total', '', t(amy.taxable + ben.taxable), t(amy.tax)]
		]);
		expect((await rows(who.cfo, runId, 'tax'))[1]).toEqual([a, 'Amy', '123456789012', t(amy.taxable), t(amy.tax)]);

		expect(await code(rows(who.po, runId, 'bank'))).toBe('forbidden');
		expect(await code(rows(who.fin, runId, 'bank'))).toBe('not_approved');
		expect(await code(rows(who.adm, runId, 'register'))).toBe('forbidden');
		expect(await code(rows(who.fin, runId, 'payslips'))).toBe('invalid: Choose a payroll report.');
		expect(await code(rows(who.fin, 'nope', 'pf'))).toBe('invalid: Choose a payroll run.');

		await approveRun(who.fin, { runId });
		expect(await exportPayroll(who.fin, { runId, kind: 'bank' })).toEqual({
			fileName: 'regular-2024-07-bank.csv',
			rows: [
				['Code', 'Name', 'Bank', 'Account name', 'Account number', 'Amount'],
				[a, 'Amy', 'City Bank', 'Amy', '=0012345', t(amy.net)],
				[b, 'Ben', null, null, null, t(ben.net)],
				['Total', '', '', '', '', t(amy.net + ben.net)]
			]
		});
		const events = await db((tx) =>
			tx.select({ event: auditLog.event, rowId: auditLog.rowId }).from(auditLog).where(eq(auditLog.rowId, runId))
		);
		expect(
			events
				.filter((e) => e.event?.startsWith('payroll.export.'))
				.map((e) => e.event)
				.sort()
		).toEqual([
			'payroll.export.bank',
			'payroll.export.pf',
			'payroll.export.register',
			'payroll.export.tax',
			'payroll.export.tax'
		]);

		await db((tx) => tx.update(payrollRuns).set({ status: 'void' }).where(eq(payrollRuns.id, runId)));
		expect(await code(rows(who.fin, runId, 'register'))).toBe('not_found');

		ids.cid = await hire('Cid', '2024-08-01');
		const august = await startRun(who.po, { period: '2024-08' });
		expect((await slipOf(august, ids.cid)).error).toBeTruthy();
		expect(await code(rows(who.po, august, 'register'))).toBe('has_errors');
	});
});
