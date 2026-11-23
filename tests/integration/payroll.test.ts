import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roundTaka } from '../../src/lib/payroll';
import { closePools } from '../../src/lib/server/db';
import {
	attendanceDays,
	attendanceRequests,
	employees,
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
		expect(await myPayslips(who.ana)).toEqual([{ id: ana.id, period: P, runType: 'regular', net: 4_500_000 }]);
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
