import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
	computeArrears,
	computeBonus,
	computePay,
	failed,
	runName,
	serviceMonths,
	slipName,
	type LineKind,
	type PayLine,
	type PayResult,
	type Segment,
	type Settle
} from '../payroll';
import { poishaOf } from '../money';
import { fiscalMonths, fiscalYearOf, type TaxCategory } from '../tax';
import type { ApprovalItem } from './approvals';
import { singleAdmin } from './approval-chain';
import { assetCharges } from './assets';
import {
	attendanceDays,
	attendanceRequests,
	employeeSalaries,
	employeeSalaryLines,
	employees,
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
	payComponents,
	payrollRuns,
	payslipLines,
	payslips,
	taxSlabs,
	taxYears,
	tenantSettings
} from './db/schema';
import { config } from './config';
import { addDays, addMonths } from './dates';
import { AppError } from './errors';
import { fiscalYearOf as leaveYearOf, isWorkingDay } from './leave-days';
import { tenantToday } from './lifecycle';
import { advisoryLock, LOCK } from './locks';
import { log } from './log';
import { sendMail } from './mail';
import { periodRange } from './meal-bills';
import { renderPayslipPdf } from './payslip-pdf';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { withTenant, type Tx } from './tenancy';
import { tenantCurrency } from './settings';

type Member = ReturnType<typeof requireMember>;
type Run = {
	id: string;
	period: string;
	runType: string;
	title: string | null;
	employeeId?: string | null;
	noticePayDays?: number;
	noticeShortDays?: number;
	assetDeduction?: number;
};

const periodSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month.') });
const startSchema = periodSchema
	.extend({
		runType: z.enum(['regular', 'bonus', 'arrears'], 'Choose what to pay.').default('regular'),
		title: z
			.string()
			.trim()
			.max(60, 'The bonus name is up to 60 characters.')
			.regex(/^[^\p{Cc}]*$/u, 'The bonus name cannot have line breaks.')
			.default('')
	})
	.refine((v) => v.runType !== 'bonus' || v.title, {
		message: 'Name the bonus, like Eid-ul-Fitr bonus.',
		path: ['title']
	});
const noticeDays = (msg: string) =>
	z.coerce.number().int('Enter whole days of notice.').min(0, msg).max(365, msg).default(0);
const finalSchema = z
	.object({
		employeeId: z.uuid({ error: 'Choose who is leaving.' }),
		noticePayDays: noticeDays('Notice paid in lieu is 0 to 365 days.'),
		noticeShortDays: noticeDays('Notice shortfall is 0 to 365 days.'),
		assetDeduction: z
			.string()
			.trim()
			.regex(/^(\d{1,7}(\.\d{1,2})?)?$/, 'Enter the asset deduction, up to 2 decimals.')
			.default('')
			.transform((v) => (v ? poishaOf(v) : 0))
	})
	.refine((v) => !(v.noticePayDays && v.noticeShortDays), {
		message: 'Enter notice paid in lieu or a notice shortfall, not both.',
		path: ['noticeShortDays']
	});
const runSchema = z.object({ runId: z.uuid({ error: 'Choose a payroll run.' }) });

const LINE_NAMES: Record<string, string> = {
	OVERTIME: 'Overtime',
	EXPENSE: 'Expense reimbursement',
	PF_EMPLOYER: 'Provident fund (employer)'
};

const allScope = (access: Access, perm: 'payroll.run' | 'payroll.approve') => scopesOf(access, perm).includes('all');

function payrollCtx(m: Member, perm: 'payroll.run' | 'payroll.approve') {
	if (!allScope(m.access, perm)) throw new AppError('forbidden', 'Payroll needs access to everyone.', 403);
	return userCtx(m, { payrollAll: true, salaryAll: true });
}

const notFound = () => new AppError('not_found', 'That payroll run does not exist.', 404);
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const finalsIn = (tx: Tx, period: string) =>
	tx
		.select({ id: payrollRuns.employeeId })
		.from(payrollRuns)
		.where(and(eq(payrollRuns.runType, 'final'), ne(payrollRuns.status, 'void'), eq(payrollRuns.period, period)));

const among = (ids: string[]) => (col: PgColumn) => (ids.length ? inArray(col, ids) : sql`false`);

export async function loadBonusInputs(tx: Tx, run: Run) {
	const { to } = periodRange(run.period);
	const [settings] = await tx
		.select({ rateBp: tenantSettings.bonusRateBp, minMonths: tenantSettings.bonusMinServiceMonths })
		.from(tenantSettings);
	const people = await tx
		.select({ id: employees.id, join: employees.joinDate })
		.from(employees)
		.where(
			and(
				lte(employees.joinDate, to),
				or(isNull(employees.exitDate), gte(employees.exitDate, to)),
				notInArray(employees.id, finalsIn(tx, run.period))
			)
		)
		.orderBy(asc(employees.id));
	const basics = await tx
		.select({ employeeId: employeeSalaries.employeeId, amount: employeeSalaryLines.amount })
		.from(employeeSalaries)
		.innerJoin(employeeSalaryLines, eq(employeeSalaryLines.salaryId, employeeSalaries.id))
		.innerJoin(payComponents, eq(payComponents.id, employeeSalaryLines.componentId))
		.where(
			and(
				among(people.map((p) => p.id))(employeeSalaries.employeeId),
				eq(payComponents.code, 'BASIC'),
				lte(employeeSalaries.effectiveFrom, to),
				or(isNull(employeeSalaries.effectiveTo), gte(employeeSalaries.effectiveTo, to))
			)
		)
		.orderBy(asc(employeeSalaries.employeeId), desc(employeeSalaries.effectiveFrom));
	return { period: run.period, to, fy: fiscalYearOf(to), title: run.title ?? '', settings, people, basics };
}

export function computeBonusRun(inputs: Awaited<ReturnType<typeof loadBonusInputs>>) {
	return inputs.people
		.filter((p) => serviceMonths(p.join, inputs.to) >= inputs.settings.minMonths)
		.map((p) => {
			const basic = inputs.basics.find((b) => b.employeeId === p.id);
			const result = basic
				? computeBonus(basic.amount, inputs.settings.rateBp, inputs.title)
				: failed(`No approved salary on ${inputs.to}.`);
			return { employeeId: p.id, ...result };
		})
		.filter((s) => s.error || s.gross);
}

export async function loadArrearsInputs(tx: Tx, run: Run) {
	const [{ lookback }] = await tx.select({ lookback: tenantSettings.arrearsLookbackMonths }).from(tenantSettings);
	const window = Array.from({ length: lookback + 1 }, (_, i) => addMonths(run.period, i - lookback));
	const paid = await tx
		.select({
			employeeId: payslipLines.employeeId,
			month: sql<string>`coalesce(${payslipLines.forPeriod}, ${payrollRuns.period})`,
			regular: sql<boolean>`${payrollRuns.runType} = 'regular'`,
			code: payslipLines.code,
			kind: payslipLines.kind,
			taxable: payslipLines.taxable,
			amount: payslipLines.amount
		})
		.from(payslipLines)
		.innerJoin(payslips, eq(payslips.id, payslipLines.payslipId))
		.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
		.where(
			and(
				inArray(payrollRuns.status, ['approved', 'paid']),
				or(
					and(eq(payrollRuns.runType, 'regular'), inArray(payrollRuns.period, window)),
					and(eq(payrollRuns.runType, 'arrears'), inArray(payslipLines.forPeriod, window))
				),
				notInArray(payslipLines.employeeId, finalsIn(tx, run.period))
			)
		)
		.orderBy(asc(payslipLines.employeeId), asc(payslipLines.payslipId), asc(payslipLines.seq));
	const regulars = await tx
		.select({ period: payrollRuns.period, settings: payrollRuns.settings })
		.from(payrollRuns)
		.where(
			and(
				eq(payrollRuns.runType, 'regular'),
				inArray(payrollRuns.status, ['approved', 'paid']),
				inArray(payrollRuns.period, window)
			)
		)
		.orderBy(asc(payrollRuns.period));
	const months = await Promise.all(
		regulars.map(async (r) => {
			const inputs = await loadPayrollInputs(tx, { ...run, period: r.period });
			const settings = (r.settings as typeof inputs.settings | null) ?? inputs.settings;
			return { period: r.period, inputs: { ...inputs, settings, ytd: [], expenses: [], instalments: [], meals: [] } };
		})
	);
	return {
		period: run.period,
		fy: fiscalYearOf(`${run.period}-01`),
		months,
		paid: paid.map((l) => ({ ...l, kind: l.kind as LineKind }))
	};
}

export function computeArrearsRun(inputs: Awaited<ReturnType<typeof loadArrearsInputs>>) {
	const dues = inputs.months.map((m) => ({ period: m.period, slips: computeRun(m.inputs) }));
	return [...new Set(inputs.paid.map((l) => l.employeeId))]
		.map((id) => {
			const mine = inputs.paid.filter((l) => l.employeeId === id);
			const months: Parameters<typeof computeArrears>[0] = [];
			let error: string | null = null;
			for (const d of dues) {
				const paid = mine.filter((l) => l.month === d.period);
				const due = d.slips.find((s) => s.employeeId === id);
				if (!due || !paid.some((l) => l.regular)) continue;
				if (due.error) error ??= `${d.period}: ${due.error}`;
				else months.push({ period: d.period, due: due.lines, paid });
			}
			return { employeeId: id, ...(error ? failed(error) : computeArrears(months)) };
		})
		.filter((s) => s.error || s.net > 0);
}

export async function loadPayrollInputs(tx: Tx, run: Run) {
	const { from, to } = periodRange(run.period);
	const fy = fiscalYearOf(from);
	const months = fiscalMonths(fy);
	const final = run.runType === 'final';
	const [settings] = await tx
		.select({
			weekendDays: tenantSettings.weekendDays,
			basis: tenantSettings.payrollProrationBasis,
			latePolicyCount: tenantSettings.latePolicyCount,
			mealLag: tenantSettings.mealPayrollLagMonths,
			pfEmployeeRateBp: tenantSettings.pfEmployeeRateBp,
			pfEmployerRateBp: tenantSettings.pfEmployerRateBp,
			overtimeRateBp: tenantSettings.overtimeRateBp,
			overtimeMonthlyHours: tenantSettings.overtimeMonthlyHours
		})
		.from(tenantSettings);
	const people = await tx
		.select({
			id: employees.id,
			name: employees.fullName,
			join: employees.joinDate,
			exit: employees.exitDate
		})
		.from(employees)
		.where(
			final
				? eq(employees.id, run.employeeId ?? sql`null`)
				: and(
						lte(employees.joinDate, to),
						or(isNull(employees.exitDate), gte(employees.exitDate, from)),
						notInArray(employees.id, finalsIn(tx, run.period))
					)
		)
		.orderBy(asc(employees.id));
	const mine = among(people.map((p) => p.id));
	const salaries = await tx
		.select({
			id: employeeSalaries.id,
			employeeId: employeeSalaries.employeeId,
			from: employeeSalaries.effectiveFrom,
			to: employeeSalaries.effectiveTo
		})
		.from(employeeSalaries)
		.where(
			and(
				mine(employeeSalaries.employeeId),
				lte(employeeSalaries.effectiveFrom, to),
				or(isNull(employeeSalaries.effectiveTo), gte(employeeSalaries.effectiveTo, from))
			)
		)
		.orderBy(asc(employeeSalaries.id));
	const salaryLines = salaries.length
		? await tx
				.select({
					id: employeeSalaryLines.id,
					salaryId: employeeSalaryLines.salaryId,
					code: payComponents.code,
					name: payComponents.name,
					kind: payComponents.kind,
					taxable: payComponents.taxable,
					amount: employeeSalaryLines.amount
				})
				.from(employeeSalaryLines)
				.innerJoin(payComponents, eq(payComponents.id, employeeSalaryLines.componentId))
				.where(
					inArray(
						employeeSalaryLines.salaryId,
						salaries.map((s) => s.id)
					)
				)
				.orderBy(asc(employeeSalaryLines.id))
		: [];
	const names = await tx
		.select({ code: payComponents.code, name: payComponents.name })
		.from(payComponents)
		.orderBy(asc(payComponents.code));
	const offDays = await tx
		.select({ date: holidays.date })
		.from(holidays)
		.where(and(gte(holidays.date, from), lte(holidays.date, to)))
		.orderBy(asc(holidays.date));
	const attendance = await tx
		.select({
			id: attendanceDays.id,
			employeeId: attendanceDays.employeeId,
			date: attendanceDays.date,
			status: attendanceDays.status,
			late: attendanceDays.lateMinutes
		})
		.from(attendanceDays)
		.where(
			and(
				mine(attendanceDays.employeeId),
				gte(attendanceDays.date, from),
				lte(attendanceDays.date, to),
				or(inArray(attendanceDays.status, ['absent', 'half_day']), gt(attendanceDays.lateMinutes, 0))
			)
		)
		.orderBy(asc(attendanceDays.id));
	const unpaidLeave = await tx
		.select({
			id: leaveRequestDays.id,
			employeeId: leaveRequestDays.employeeId,
			date: leaveRequestDays.date,
			session: leaveRequestDays.session
		})
		.from(leaveRequestDays)
		.innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
		.innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
		.where(
			and(
				mine(leaveRequestDays.employeeId),
				eq(leaveRequestDays.status, 'approved'),
				eq(leaveTypes.paid, false),
				gte(leaveRequestDays.date, from),
				lte(leaveRequestDays.date, to)
			)
		)
		.orderBy(asc(leaveRequestDays.id));
	const overtime = await tx
		.select({
			id: attendanceRequests.id,
			employeeId: attendanceRequests.employeeId,
			minutes: attendanceRequests.approvedMinutes
		})
		.from(attendanceRequests)
		.leftJoin(leaveLedger, and(eq(leaveLedger.refId, attendanceRequests.id), eq(leaveLedger.kind, 'comp_credit')))
		.where(
			and(
				mine(attendanceRequests.employeeId),
				eq(attendanceRequests.kind, 'overtime'),
				eq(attendanceRequests.status, 'approved'),
				gte(attendanceRequests.date, from),
				lte(attendanceRequests.date, to),
				isNull(leaveLedger.id)
			)
		)
		.orderBy(asc(attendanceRequests.id));
	const claimable = (col: PgColumn) => or(isNull(col), eq(col, run.id));
	const expenses = await tx
		.select({ id: expenseClaims.id, employeeId: expenseClaims.employeeId, amount: expenseClaims.total })
		.from(expenseClaims)
		.where(
			and(
				mine(expenseClaims.employeeId),
				eq(expenseClaims.status, 'approved'),
				eq(expenseClaims.payVia, 'payroll'),
				claimable(expenseClaims.payrollRunId)
			)
		)
		.orderBy(asc(expenseClaims.id));
	const meals = await tx
		.select({
			id: mealBills.id,
			employeeId: mealBills.employeeId,
			period: mealBills.period,
			amount: sql<number>`${mealBills.total} - ${mealBills.paid}`.mapWith(Number)
		})
		.from(mealBills)
		.where(
			and(
				mine(mealBills.employeeId),
				final
					? inArray(mealBills.status, ['issued', 'partially_paid'])
					: and(
							eq(mealBills.status, 'issued'),
							eq(mealBills.billingMode, 'payroll'),
							lte(mealBills.period, addMonths(run.period, -(settings?.mealLag ?? 1)))
						),
				gt(sql`${mealBills.total} - ${mealBills.paid}`, 0),
				claimable(mealBills.payrollRunId)
			)
		)
		.orderBy(asc(mealBills.period), asc(mealBills.id));
	const instalments = await tx
		.select({
			id: loanInstalments.id,
			employeeId: loanInstalments.employeeId,
			period: loanInstalments.period,
			amount: loanInstalments.amount
		})
		.from(loanInstalments)
		.where(
			and(
				mine(loanInstalments.employeeId),
				eq(loanInstalments.status, 'due'),
				final ? undefined : lte(loanInstalments.period, run.period),
				claimable(loanInstalments.payrollRunId)
			)
		)
		.orderBy(asc(loanInstalments.period), asc(loanInstalments.id));
	const [year] = await tx
		.select({
			id: taxYears.id,
			minimumTax: taxYears.minimumTax,
			exemptionCap: taxYears.exemptionCap,
			exemptionDivisor: taxYears.exemptionDivisor
		})
		.from(taxYears)
		.where(eq(taxYears.fy, fy));
	const slabs = year
		? await tx
				.select({ category: taxSlabs.category, width: taxSlabs.width, rateBp: taxSlabs.rateBp })
				.from(taxSlabs)
				.where(eq(taxSlabs.taxYearId, year.id))
				.orderBy(asc(taxSlabs.category), asc(taxSlabs.seq))
		: [];
	const profiles = year
		? await tx
				.select({
					employeeId: employeeTaxProfiles.employeeId,
					category: employeeTaxProfiles.category,
					prevIncome: employeeTaxProfiles.prevEmployerIncome,
					prevTax: employeeTaxProfiles.prevTaxPaid,
					rebate: employeeTaxProfiles.rebate
				})
				.from(employeeTaxProfiles)
				.where(and(eq(employeeTaxProfiles.taxYearId, year.id), mine(employeeTaxProfiles.employeeId)))
				.orderBy(asc(employeeTaxProfiles.employeeId))
		: [];
	const ytd = await tx
		.select({
			employeeId: payslips.employeeId,
			taxable: sql<number>`sum(${payslips.taxable})`.mapWith(Number),
			tax: sql<number>`sum(${payslips.tax})`.mapWith(Number)
		})
		.from(payslips)
		.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
		.where(
			and(
				mine(payslips.employeeId),
				inArray(payrollRuns.status, ['approved', 'paid']),
				inArray(payrollRuns.period, months),
				lte(payrollRuns.period, run.period)
			)
		)
		.groupBy(payslips.employeeId)
		.orderBy(asc(payslips.employeeId));
	return {
		period: run.period,
		fy,
		remainingMonths: final ? 1 : months.length - months.indexOf(run.period),
		settings,
		people,
		salaries,
		salaryLines,
		names,
		offDays: offDays.map((h) => h.date),
		attendance,
		unpaidLeave,
		overtime,
		expenses,
		meals,
		instalments,
		year: year ?? null,
		slabs,
		profiles,
		ytd
	};
}

type Inputs = Awaited<ReturnType<typeof loadPayrollInputs>>;

async function encashable(tx: Tx, employeeId: string, exit: string) {
	const [{ fyStart }] = await tx.select({ fyStart: tenantSettings.fiscalYearStartMonth }).from(tenantSettings);
	const fiscalYear = leaveYearOf(exit, fyStart);
	const days = sql<number>`sum(${leaveLedger.days})`.mapWith(Number);
	return tx
		.select({
			leaveTypeId: leaveTypes.id,
			name: leaveTypes.name,
			fiscalYear: sql<number>`${fiscalYear}::int`.mapWith(Number),
			days
		})
		.from(leaveLedger)
		.innerJoin(leaveTypes, eq(leaveTypes.id, leaveLedger.leaveTypeId))
		.where(
			and(
				eq(leaveLedger.employeeId, employeeId),
				eq(leaveLedger.fiscalYear, fiscalYear),
				eq(leaveTypes.encashable, true)
			)
		)
		.groupBy(leaveTypes.id, leaveTypes.name)
		.having(sql`sum(${leaveLedger.days}) > 0`)
		.orderBy(asc(leaveTypes.name));
}

export async function loadFinalInputs(tx: Tx, run: Run) {
	const inputs = await loadPayrollInputs(tx, run);
	const employeeId = run.employeeId!;
	const [settings] = await tx
		.select({
			gratuityDays: tenantSettings.gratuityDaysPerYear,
			gratuityMinYears: tenantSettings.gratuityMinYears,
			vestingMonths: tenantSettings.pfVestingMonths
		})
		.from(tenantSettings);
	const exit = inputs.people[0]?.exit ?? null;
	const [salaryPaid] = await tx
		.select({ id: payslips.id })
		.from(payslips)
		.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
		.where(
			and(
				eq(payslips.employeeId, employeeId),
				eq(payrollRuns.runType, 'regular'),
				eq(payrollRuns.period, run.period),
				inArray(payrollRuns.status, ['approved', 'paid'])
			)
		)
		.limit(1);
	const [pf] = await tx
		.select({
			own: sql<number>`coalesce(sum(case when ${payslipLines.code} <> 'PF' then 0 when ${payslipLines.kind} = 'deduction' then ${payslipLines.amount} else -${payslipLines.amount} end), 0)`.mapWith(
				Number
			),
			employer:
				sql<number>`coalesce(sum(case when ${payslipLines.code} = 'PF_EMPLOYER' then ${payslipLines.amount} else 0 end), 0)`.mapWith(
					Number
				)
		})
		.from(payslipLines)
		.innerJoin(payslips, eq(payslips.id, payslipLines.payslipId))
		.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
		.where(and(eq(payslipLines.employeeId, employeeId), inArray(payrollRuns.status, ['approved', 'paid'])));
	return {
		...inputs,
		final: {
			employeeId,
			settings,
			salaryPaid: Boolean(salaryPaid),
			leave: exit ? (await encashable(tx, employeeId, exit)).map(({ name, days }) => ({ name, days })) : [],
			pfOwn: pf.own,
			pfEmployer: pf.employer,
			noticePayDays: run.noticePayDays ?? 0,
			noticeShortDays: run.noticeShortDays ?? 0,
			asset: run.assetDeduction ?? 0
		}
	};
}

export function computeFinalRun(inputs: Awaited<ReturnType<typeof loadFinalInputs>>) {
	const f = inputs.final;
	const p = inputs.people[0];
	if (!p?.exit || p.exit.slice(0, 7) !== inputs.period)
		return [
			{
				employeeId: f.employeeId,
				...failed(`The exit date is no longer in ${inputs.period}. Void this run and start a new one.`)
			}
		];
	const months = serviceMonths(p.join, addDays(p.exit, 1));
	return computeRun(inputs, {
		salaryPaid: f.salaryPaid,
		leave: f.leave,
		serviceYears: Math.floor(months / 12),
		gratuityDays: f.settings.gratuityDays,
		gratuityMinYears: f.settings.gratuityMinYears,
		noticePayDays: f.noticePayDays,
		noticeShortDays: f.noticeShortDays,
		asset: f.asset,
		pfOwn: f.pfOwn,
		pfEmployer: f.pfEmployer,
		pfVested: months >= f.settings.vestingMonths
	});
}

export function computeRun(inputs: Inputs, settle?: Settle) {
	const { from, to } = periodRange(inputs.period);
	const s = inputs.settings;
	const holidaySet = new Set(inputs.offDays);
	const all: string[] = [];
	for (let d = from; d <= to; d = addDays(d, 1)) all.push(d);
	const days =
		s.basis === 'working'
			? all.filter((d) => isWorkingDay(d, { weekendDays: s.weekendDays, holidays: holidaySet }))
			: all;
	const names = { ...LINE_NAMES, ...Object.fromEntries(inputs.names.map((n) => [n.code, n.name])) };
	const byEmployee = <T extends { employeeId: string }>(rows: T[], id: string) =>
		rows.filter((r) => r.employeeId === id);
	return inputs.people.map((p) => {
		const segments: Segment[] = byEmployee(inputs.salaries, p.id).map((sal) => ({
			from: sal.from,
			to: sal.to,
			parts: inputs.salaryLines
				.filter((l) => l.salaryId === sal.id)
				.map((l) => ({
					code: l.code,
					name: l.name,
					kind: l.kind as 'earning' | 'deduction',
					taxable: l.taxable,
					amount: l.amount
				}))
		}));
		const attendance = byEmployee(inputs.attendance, p.id);
		const profile = inputs.profiles.find((x) => x.employeeId === p.id);
		const ytd = inputs.ytd.find((x) => x.employeeId === p.id);
		const category = (profile?.category ?? 'general') as TaxCategory;
		const result = computePay({
			days,
			join: p.join,
			exit: p.exit,
			segments,
			unpaid: [
				...attendance
					.filter((a) => a.status === 'absent' || a.status === 'half_day')
					.map((a) => ({ date: a.date, days: a.status === 'absent' ? 1 : 0.5 })),
				...byEmployee(inputs.unpaidLeave, p.id).map((l) => ({
					date: l.date,
					days: l.session === 'full' ? 1 : 0.5
				}))
			],
			lates: attendance.filter((a) => a.late > 0).length,
			latePolicyCount: s.latePolicyCount,
			overtimeMinutes: byEmployee(inputs.overtime, p.id).reduce((sum, o) => sum + (o.minutes ?? 0), 0),
			overtimeRateBp: s.overtimeRateBp,
			overtimeMonthlyHours: s.overtimeMonthlyHours,
			pfEmployeeRateBp: s.pfEmployeeRateBp,
			pfEmployerRateBp: s.pfEmployerRateBp,
			expenses: byEmployee(inputs.expenses, p.id),
			instalments: byEmployee(inputs.instalments, p.id),
			meals: byEmployee(inputs.meals, p.id),
			tax: {
				rule: inputs.year && {
					...inputs.year,
					bands: inputs.slabs.filter((b) => b.category === category).map(({ width, rateBp }) => ({ width, rateBp }))
				},
				rebate: profile?.rebate ?? 0,
				prevIncome: profile?.prevIncome ?? 0,
				prevTax: profile?.prevTax ?? 0,
				ytdTaxable: ytd?.taxable ?? 0,
				ytdTax: ytd?.tax ?? 0,
				remainingMonths: inputs.remainingMonths
			},
			names,
			settle
		});
		return { employeeId: p.id, ...result };
	});
}

type Slip = { employeeId: string } & PayResult;
type SlipShape = Omit<Slip, 'claimed' | 'skipped' | 'lines'> & { notes: string[]; lines: PayLine[] };

const canonical = (slips: SlipShape[]) =>
	[...slips]
		.sort((a, b) => (a.employeeId < b.employeeId ? -1 : 1))
		.map((s) => [
			s.employeeId,
			s.paidDays,
			s.unpaidDays,
			s.gross,
			s.deductions,
			s.rounding,
			s.net,
			s.taxable,
			s.tax,
			s.error,
			s.notes,
			s.lines.map((l) => [l.code, l.name, l.kind, l.taxable, l.amount, l.forPeriod ?? null])
		]);

const asStored = (slips: Slip[]) => canonical(slips.map((s) => ({ ...s, notes: s.skipped })));

export async function storedSlips(tx: Tx, runId: string) {
	const slips = await tx.select().from(payslips).where(eq(payslips.runId, runId));
	const lines = slips.length
		? await tx
				.select()
				.from(payslipLines)
				.where(
					inArray(
						payslipLines.payslipId,
						slips.map((s) => s.id)
					)
				)
				.orderBy(asc(payslipLines.seq))
		: [];
	return slips.map((s) => ({
		...s,
		lines: lines.filter((l) => l.payslipId === s.id).map((l) => ({ ...l, kind: l.kind as PayLine['kind'] }))
	}));
}

async function compute(tx: Tx, run: Run) {
	if (run.runType === 'bonus') {
		const inputs = await loadBonusInputs(tx, run);
		return { inputs, slips: computeBonusRun(inputs), snapshot: null };
	}
	if (run.runType === 'arrears') {
		const inputs = await loadArrearsInputs(tx, run);
		return { inputs, slips: computeArrearsRun(inputs), snapshot: null };
	}
	if (run.runType === 'final') {
		const inputs = await loadFinalInputs(tx, run);
		return { inputs, slips: computeFinalRun(inputs), snapshot: null };
	}
	const inputs = await loadPayrollInputs(tx, run);
	return { inputs, slips: computeRun(inputs), snapshot: inputs.settings };
}

async function computeInto(tx: Tx, m: Member, run: Run) {
	const { inputs, slips, snapshot } = await compute(tx, run);
	await tx.delete(payslips).where(eq(payslips.runId, run.id));
	const rows = slips.length
		? await tx
				.insert(payslips)
				.values(
					slips.map((s) => ({
						tenantId: m.tenant.id,
						runId: run.id,
						employeeId: s.employeeId,
						paidDays: s.paidDays,
						unpaidDays: s.unpaidDays,
						gross: s.gross,
						deductions: s.deductions,
						rounding: s.rounding,
						net: s.net,
						taxable: s.taxable,
						tax: s.tax,
						error: s.error,
						notes: s.skipped
					}))
				)
				.returning({ id: payslips.id, employeeId: payslips.employeeId })
		: [];
	const lines = slips.flatMap((s) => {
		const payslipId = rows.find((r) => r.employeeId === s.employeeId)!.id;
		return s.lines.map((l, seq) => ({ tenantId: m.tenant.id, payslipId, employeeId: s.employeeId, seq, ...l }));
	});
	if (lines.length) await tx.insert(payslipLines).values(lines);
	await tx
		.update(payrollRuns)
		.set({
			settings: snapshot,
			currency: await tenantCurrency(tx),
			inputsHash: sha(inputs),
			outputHash: sha(asStored(slips)),
			computedByUserId: m.user.userId,
			computedAt: new Date()
		})
		.where(eq(payrollRuns.id, run.id));
}

async function lockedRun(tx: Tx, m: Member, runId: string) {
	await advisoryLock(tx, LOCK.payroll, m.tenant.id);
	const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId)).for('update');
	if (!run) throw notFound();
	return run;
}

async function startFinal(m: Member, form: Record<string, string>) {
	const input = finalSchema.parse(form);
	const useRecordedCharges = !(form.assetDeduction ?? '').trim();
	return withTenant(payrollCtx(m, 'payroll.run'), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const [e] = await tx
			.select({ name: employees.fullName, exit: employees.exitDate })
			.from(employees)
			.where(eq(employees.id, input.employeeId));
		if (!e) throw new AppError('not_found', 'That employee does not exist.', 404);
		if (!e.exit) throw new AppError('no_exit', `Set ${e.name}'s exit date before settling.`, 409);
		const period = e.exit.slice(0, 7);
		if (period > (await tenantToday(tx)).slice(0, 7))
			throw new AppError('future', `Settle ${e.name} once ${period} starts.`, 400);
		const [pending] = await tx
			.select({ id: payslips.id })
			.from(payslips)
			.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
			.where(
				and(
					eq(payslips.employeeId, input.employeeId),
					eq(payrollRuns.runType, 'regular'),
					eq(payrollRuns.period, period),
					eq(payrollRuns.status, 'computed')
				)
			)
			.limit(1);
		if (pending)
			throw new AppError(
				'in_payroll',
				`${e.name} is in the ${period} payroll waiting for approval. Approve or void it first.`,
				409
			);
		if (useRecordedCharges) input.assetDeduction = await assetCharges(tx, input.employeeId);
		const [run] = await tx
			.insert(payrollRuns)
			.values({
				tenantId: m.tenant.id,
				runType: 'final',
				period,
				...input,
				inputsHash: '',
				outputHash: '',
				computedByUserId: m.user.userId,
				computedAt: new Date()
			})
			.onConflictDoNothing()
			.returning();
		if (!run) throw new AppError('exists', `${e.name} already has a final settlement.`, 409);
		await computeInto(tx, m, run);
		return run.id;
	});
}

export async function startRun(m: Member, form: Record<string, string>) {
	if (form.runType === 'final') return startFinal(m, form);
	const { period, runType, title } = startSchema.parse(form);
	return withTenant(payrollCtx(m, 'payroll.run'), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		if (period > (await tenantToday(tx)).slice(0, 7))
			throw new AppError('future', 'Payroll cannot run for a future month.', 400);
		const [run] = await tx
			.insert(payrollRuns)
			.values({
				tenantId: m.tenant.id,
				runType,
				title: runType === 'bonus' ? title : null,
				period,
				inputsHash: '',
				outputHash: '',
				computedByUserId: m.user.userId,
				computedAt: new Date()
			})
			.onConflictDoNothing()
			.returning({
				id: payrollRuns.id,
				period: payrollRuns.period,
				runType: payrollRuns.runType,
				title: payrollRuns.title
			});
		if (!run) throw new AppError('exists', `Payroll for ${period} is already started.`, 409);
		await computeInto(tx, m, run);
		return run.id;
	});
}

export async function recomputeRun(m: Member, form: Record<string, string>) {
	const { runId } = runSchema.parse(form);
	await withTenant(payrollCtx(m, 'payroll.run'), async (tx) => {
		const run = await lockedRun(tx, m, runId);
		if (run.status !== 'computed')
			throw new AppError('locked', 'Only a run waiting for approval can be recomputed.', 409);
		await computeInto(tx, m, run);
	});
}

export async function voidRun(m: Member, form: Record<string, string>) {
	const { runId } = runSchema.parse(form);
	await withTenant(payrollCtx(m, 'payroll.run'), async (tx) => {
		const run = await lockedRun(tx, m, runId);
		if (run.status !== 'computed') throw new AppError('locked', 'Only a run waiting for approval can be voided.', 409);
		await tx.update(payrollRuns).set({ status: 'void' }).where(eq(payrollRuns.id, run.id));
	});
}

export async function approveRun(m: Member, form: Record<string, string>) {
	const { runId } = runSchema.parse(form);
	await withTenant(payrollCtx(m, 'payroll.approve'), async (tx) => {
		const run = await lockedRun(tx, m, runId);
		if (run.status !== 'computed') throw new AppError('locked', 'That run is not waiting for approval.', 409);
		if (run.computedByUserId === m.user.userId && !(await singleAdmin(tx)))
			throw new AppError('own_run', 'Someone other than the person who computed the run must approve it.', 403);
		const [earlier] = await tx
			.select({ period: payrollRuns.period })
			.from(payrollRuns)
			.where(
				and(eq(payrollRuns.runType, 'regular'), eq(payrollRuns.status, 'computed'), lt(payrollRuns.period, run.period))
			)
			.orderBy(asc(payrollRuns.period))
			.limit(1);
		if (earlier)
			throw new AppError(
				'earlier_open',
				`Approve or void the ${earlier.period} payroll first; tax for later months depends on it.`,
				409
			);
		const { inputs, slips } = await compute(tx, run);
		const [year] = await tx
			.select({ confirmedAt: taxYears.confirmedAt })
			.from(taxYears)
			.where(eq(taxYears.fy, inputs.fy));
		if (!year?.confirmedAt)
			throw new AppError('tax_unconfirmed', `Confirm the ${inputs.fy} tax rules before approving payroll.`, 409);
		if (sha(inputs) !== run.inputsHash)
			throw new AppError('inputs_changed', 'Payroll inputs changed since this run was computed. Recompute it.', 409);
		const stored = await storedSlips(tx, run.id);
		if (sha(canonical(stored)) !== run.outputHash || sha(asStored(slips)) !== run.outputHash)
			throw new AppError('output_changed', 'Stored payslips no longer match the computation. Recompute it.', 409);
		if (stored.some((s) => s.error))
			throw new AppError('has_errors', 'Fix the payslips with problems and recompute before approving.', 409);
		const claim = async (table: typeof expenseClaims | typeof mealBills | typeof loanInstalments, ids: string[]) => {
			if (ids.length) await tx.update(table).set({ payrollRunId: run.id }).where(inArray(table.id, ids));
		};
		await claim(
			expenseClaims,
			slips.flatMap((s) => s.claimed.expenses)
		);
		await claim(
			mealBills,
			slips.flatMap((s) => s.claimed.meals)
		);
		await claim(
			loanInstalments,
			slips.flatMap((s) => s.claimed.instalments)
		);
		await tx
			.update(payrollRuns)
			.set({ status: 'approved', approvedByUserId: m.user.userId, approvedAt: new Date() })
			.where(eq(payrollRuns.id, run.id));
	});
}

export async function reopenRun(m: Member, form: Record<string, string>) {
	const { runId } = runSchema.parse(form);
	if (!m.access.isOwner) throw new AppError('owner_only', 'Only an owner can reopen an approved run.', 403);
	await withTenant(payrollCtx(m, 'payroll.approve'), async (tx) => {
		const run = await lockedRun(tx, m, runId);
		if (run.status !== 'approved') throw new AppError('locked', 'Only an approved, unpaid run can be reopened.', 409);
		if (run.runType === 'regular') {
			const [settled] = await tx
				.select({ id: payslips.id })
				.from(payslips)
				.where(and(eq(payslips.runId, run.id), inArray(payslips.employeeId, finalsIn(tx, run.period))))
				.limit(1);
			if (settled)
				throw new AppError(
					'settled',
					'Someone in this run has a final settlement for this month, so reopening would drop their pay.',
					409
				);
		}
		for (const table of [expenseClaims, mealBills, loanInstalments])
			await tx.update(table).set({ payrollRunId: null }).where(eq(table.payrollRunId, run.id));
		await tx
			.update(payrollRuns)
			.set({ status: 'computed', approvedByUserId: null, approvedAt: null })
			.where(eq(payrollRuns.id, run.id));
	});
}

export async function payRun(m: Member, form: Record<string, string>) {
	const { runId } = runSchema.parse(form);
	const { period, name, recipients, emailPdf } = await withTenant(payrollCtx(m, 'payroll.approve'), async (tx) => {
		const run = await lockedRun(tx, m, runId);
		if (run.status !== 'approved') throw new AppError('locked', 'Only an approved run can be marked paid.', 409);
		const now = new Date();
		await tx.update(mealBills).set({ status: 'deducted' }).where(eq(mealBills.payrollRunId, run.id));
		await tx
			.update(expenseClaims)
			.set({ status: 'paid', paidAt: now, paidByUserId: m.user.userId })
			.where(eq(expenseClaims.payrollRunId, run.id));
		const paid = await tx
			.update(loanInstalments)
			.set({ status: 'paid', paidAt: now })
			.where(eq(loanInstalments.payrollRunId, run.id))
			.returning({ loanId: loanInstalments.loanId });
		const touched = [...new Set(paid.map((p) => p.loanId))];
		if (touched.length)
			await tx
				.update(loans)
				.set({ status: 'closed' })
				.where(
					and(
						inArray(loans.id, touched),
						sql`not exists (select 1 from ${loanInstalments} where ${loanInstalments.loanId} = ${loans.id} and ${loanInstalments.status} = 'due')`
					)
				);
		await tx
			.update(payrollRuns)
			.set({ status: 'paid', paidByUserId: m.user.userId, paidAt: now })
			.where(eq(payrollRuns.id, run.id));
		if (run.runType === 'final') await encashLeave(tx, m, run);
		const recipients = await tx
			.select({
				id: payslips.id,
				name: employees.fullName,
				email: sql<
					string | null
				>`coalesce((select email from tenant_users where employee_id = ${payslips.employeeId} and membership_status = 'active' limit 1), ${employees.workEmail}, ${employees.personalEmail})`,
				membershipId: sql<
					string | null
				>`(select membership_id from tenant_users where employee_id = ${payslips.employeeId} and membership_status = 'active' limit 1)`,
				locked: sql<boolean>`exists (select 1 from member_secrets s join tenant_users u on u.membership_id = s.membership_id
					where u.employee_id = ${payslips.employeeId} and u.membership_status = 'active')`
			})
			.from(payslips)
			.innerJoin(employees, eq(employees.id, payslips.employeeId))
			.where(eq(payslips.runId, run.id));
		const [settings] = await tx.select({ pdf: tenantSettings.payslipEmailPdf }).from(tenantSettings);
		return { period: run.period, name: slipName(run), recipients, emailPdf: !!settings?.pdf };
	});
	const link = `${config().APP_URL}/t/${m.tenant.slug}/payslips`;
	await Promise.all(
		recipients.flatMap((r) =>
			r.email
				? [
						sendMail(
							{
								to: r.email,
								subject: `Your ${name ? `${name} ` : ''}payslip for ${period}`,
								text: [
									`Hello ${r.name},`,
									'',
									`Your ${name ? `${name} ` : ''}payslip for ${period} from ${m.tenant.name} is ready.`,
									`Open it here: ${link}`,
									...(emailPdf && r.membershipId && !r.locked
										? ['', 'To get the PDF attached to this email, set a payslip password on the Payslips page.']
										: [])
								].join('\n'),
								...(emailPdf &&
									r.locked &&
									r.membershipId && {
										tenantId: m.tenant.id,
										payslip: { payslipId: r.id, membershipId: r.membershipId }
									})
							},
							`payslip-mail-${r.id}`
						)
					]
				: []
		)
	).catch((err) => log.warn({ tenantId: m.tenant.id, err: (err as Error).message }, 'payslip mails not queued'));
}

async function encashLeave(tx: Tx, m: Member, run: Run) {
	const [slip] = await tx
		.select({ id: payslips.id, employeeId: payslips.employeeId, exit: employees.exitDate })
		.from(payslips)
		.innerJoin(employees, eq(employees.id, payslips.employeeId))
		.where(
			and(
				eq(payslips.runId, run.id),
				sql`exists (select 1 from ${payslipLines} where ${payslipLines.payslipId} = ${payslips.id} and ${payslipLines.code} = 'LEAVE_ENCASH')`
			)
		);
	if (!slip?.exit) return;
	const rows = await encashable(tx, slip.employeeId, slip.exit);
	if (rows.length)
		await tx.insert(leaveLedger).values(
			rows.map((r) => ({
				tenantId: m.tenant.id,
				employeeId: slip.employeeId,
				leaveTypeId: r.leaveTypeId,
				fiscalYear: r.fiscalYear,
				kind: 'encash',
				days: -r.days,
				refId: slip.id,
				note: 'Encashed in the final settlement.',
				createdByUserId: m.user.userId
			}))
		);
}

const leaver = sql<
	string | null
>`(select ${employees.fullName} from ${employees} where ${employees.id} = ${payrollRuns.employeeId})`;
const titled = (r: { runType: string; title: string | null; leaver: string | null }) =>
	[slipName(r), r.leaver].filter(Boolean).join(' · ') || null;

export function canSeePayroll(access: Access) {
	return allScope(access, 'payroll.run') || allScope(access, 'payroll.approve');
}

export async function payrollBoard(m: Member, runId?: string) {
	if (!canSeePayroll(m.access)) throw new AppError('forbidden', 'Payroll needs access to everyone.', 403);
	return withTenant(userCtx(m, { payrollAll: true }), async (tx) => {
		const runs = await tx
			.select()
			.from(payrollRuns)
			.orderBy(desc(payrollRuns.period), desc(payrollRuns.createdAt))
			.limit(36);
		const names = await tx
			.select({ id: employees.id, name: employees.fullName })
			.from(employees)
			.where(among(runs.flatMap((r) => r.employeeId ?? []))(employees.id));
		const leaverOf = (r: { employeeId: string | null }) => names.find((n) => n.id === r.employeeId)?.name ?? null;
		const leavers = await tx
			.select({
				id: employees.id,
				name: employees.fullName,
				code: employees.code,
				exit: employees.exitDate,
				charges: sql<number>`(select coalesce(sum(aa.charge), 0)::int from asset_assignments aa where aa.employee_id = employees.id and aa.returned_on >= employees.join_date)`
			})
			.from(employees)
			.where(
				and(
					sql`${employees.exitDate} is not null`,
					sql`not exists (select 1 from ${payrollRuns} where ${payrollRuns.employeeId} = ${employees.id} and ${payrollRuns.runType} = 'final' and ${payrollRuns.status} <> 'void')`
				)
			)
			.orderBy(asc(employees.fullName));
		const run = runs.find((r) => r.id === runId) ?? runs[0];
		const slips = run ? await storedSlips(tx, run.id) : [];
		const people = slips.length
			? await tx
					.select({ id: employees.id, name: employees.fullName, code: employees.code })
					.from(employees)
					.where(
						inArray(
							employees.id,
							slips.map((s) => s.employeeId)
						)
					)
			: [];
		const lone = await singleAdmin(tx);
		return {
			thisMonth: (await tenantToday(tx)).slice(0, 7),
			canRun: allScope(m.access, 'payroll.run'),
			canApprove: allScope(m.access, 'payroll.approve'),
			canReopen: m.access.isOwner && allScope(m.access, 'payroll.approve'),
			selfApprove: lone,
			me: m.user.userId,
			leavers,
			runs: runs.map((r) => ({
				id: r.id,
				period: r.period,
				name: titled({ ...r, leaver: leaverOf(r) }),
				status: r.status
			})),
			run: run && {
				...run,
				leaver: leaverOf(run),
				currency: run.currency ?? 'BDT',
				totals: {
					gross: slips.reduce((sum, s) => sum + s.gross, 0),
					deductions: slips.reduce((sum, s) => sum + s.deductions, 0),
					net: slips.reduce((sum, s) => sum + s.net, 0)
				},
				slips: slips
					.map((s) => ({ ...s, ...people.find((p) => p.id === s.employeeId)! }))
					.sort((a, b) => a.name.localeCompare(b.name))
			}
		};
	});
}

export async function payrollApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	if (!allScope(access, 'payroll.approve')) return [];
	const rows = await tx
		.select({
			id: payrollRuns.id,
			period: payrollRuns.period,
			runType: payrollRuns.runType,
			title: payrollRuns.title,
			leaver,
			at: payrollRuns.computedAt
		})
		.from(payrollRuns)
		.where(eq(payrollRuns.status, 'computed'))
		.orderBy(asc(payrollRuns.computedAt));
	return rows.map((r) => ({
		id: r.id,
		kind: 'Payroll',
		title: `${runName(r)} for ${r.period}${r.leaver ? ` · ${r.leaver}` : ''}`,
		requestedBy: 'Payroll',
		at: r.at,
		link: `payroll?run=${r.id}`
	}));
}

const runCurrency = sql<string>`coalesce(${payrollRuns.currency}, 'BDT')`;

const paidSlip = (m: Member) =>
	and(eq(payslips.employeeId, m.access.employeeId ?? sql`null`), eq(payrollRuns.status, 'paid'));

export async function myPayslips(m: Member) {
	return withTenant(userCtx(m), (tx) =>
		tx
			.select({
				id: payslips.id,
				period: payrollRuns.period,
				runType: payrollRuns.runType,
				title: payrollRuns.title,
				net: payslips.net,
				currency: runCurrency
			})
			.from(payslips)
			.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
			.where(paidSlip(m))
			.orderBy(desc(payrollRuns.period), desc(payrollRuns.paidAt))
			.then((rows) => rows.map(({ runType, title, ...r }) => ({ ...r, name: slipName({ runType, title }) })))
	);
}

export async function payslipPdfInput(tx: Tx, payslipId: string, where: SQL | undefined, company: string) {
	const [slip] = await tx
		.select({
			period: payrollRuns.period,
			runType: payrollRuns.runType,
			title: payrollRuns.title,
			employee: employees.fullName,
			code: employees.code,
			paidDays: payslips.paidDays,
			unpaidDays: payslips.unpaidDays,
			gross: payslips.gross,
			deductions: payslips.deductions,
			rounding: payslips.rounding,
			net: payslips.net,
			notes: payslips.notes,
			currency: runCurrency
		})
		.from(payslips)
		.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
		.innerJoin(employees, eq(employees.id, payslips.employeeId))
		.where(and(eq(payslips.id, payslipId), where));
	if (!slip) return null;
	const [lines, [settings]] = await Promise.all([
		tx
			.select({ name: payslipLines.name, kind: payslipLines.kind, amount: payslipLines.amount })
			.from(payslipLines)
			.where(eq(payslipLines.payslipId, payslipId))
			.orderBy(asc(payslipLines.seq)),
		tx.select({ legalName: tenantSettings.legalName }).from(tenantSettings)
	]);
	return {
		fileName: `${slip.runType === 'regular' ? 'payslip' : slip.runType}-${slip.period}.pdf`,
		pdf: {
			...slip,
			name: slipName(slip),
			company: settings?.legalName ?? company,
			lines: lines.map((l) => ({ ...l, kind: l.kind as PayLine['kind'] }))
		}
	};
}

export async function openPayslipPdf(m: Member, payslipId: string) {
	const valid = z.uuid().safeParse(payslipId).success;
	return withTenant(userCtx(m), async (tx) => {
		const found = valid ? await payslipPdfInput(tx, payslipId, paidSlip(m), m.tenant.name) : null;
		if (!found) throw new AppError('not_found', 'That payslip does not exist.', 404);
		return { fileName: found.fileName, body: await renderPayslipPdf(found.pdf) };
	});
}
