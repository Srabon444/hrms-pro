import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
	computeBonus,
	computePay,
	failed,
	serviceMonths,
	type PayLine,
	type PayResult,
	type Segment
} from '../payroll';
import { fiscalMonths, fiscalYearOf, type TaxCategory } from '../tax';
import type { ApprovalItem } from './approvals';
import { singleAdmin } from './approval-chain';
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
import { isWorkingDay } from './leave-days';
import { tenantToday } from './lifecycle';
import { advisoryLock, LOCK } from './locks';
import { log } from './log';
import { sendMail } from './mail';
import { periodRange } from './meal-bills';
import { renderPayslipPdf } from './payslip-pdf';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Run = { id: string; period: string; runType: string; title: string | null };

const periodSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month.') });
const startSchema = periodSchema
	.extend({
		runType: z.enum(['regular', 'bonus'], 'Choose what to pay.').default('regular'),
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
		.select({ id: payslips.employeeId })
		.from(payslips)
		.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
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

export async function loadPayrollInputs(tx: Tx, run: Run) {
	const { from, to } = periodRange(run.period);
	const fy = fiscalYearOf(from);
	const months = fiscalMonths(fy);
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
			and(
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
				eq(mealBills.status, 'issued'),
				eq(mealBills.billingMode, 'payroll'),
				lte(mealBills.period, addMonths(run.period, -(settings?.mealLag ?? 1))),
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
				lte(loanInstalments.period, run.period),
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
		remainingMonths: months.length - months.indexOf(run.period),
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

export function computeRun(inputs: Inputs) {
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
			names
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
			s.lines.map((l) => [l.code, l.name, l.kind, l.taxable, l.amount])
		]);

const asStored = (slips: Slip[]) => canonical(slips.map((s) => ({ ...s, notes: s.skipped })));

async function storedSlips(tx: Tx, runId: string) {
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
		return { inputs, slips: computeBonusRun(inputs) };
	}
	const inputs = await loadPayrollInputs(tx, run);
	return { inputs, slips: computeRun(inputs) };
}

async function computeInto(tx: Tx, m: Member, run: Run) {
	const { inputs, slips } = await compute(tx, run);
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

export async function startRun(m: Member, form: Record<string, string>) {
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
	const { period, title, recipients } = await withTenant(payrollCtx(m, 'payroll.approve'), async (tx) => {
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
		const recipients = await tx
			.select({
				id: payslips.id,
				name: employees.fullName,
				email: sql<
					string | null
				>`coalesce((select email from tenant_users where employee_id = ${payslips.employeeId} and membership_status = 'active' limit 1), ${employees.workEmail}, ${employees.personalEmail})`
			})
			.from(payslips)
			.innerJoin(employees, eq(employees.id, payslips.employeeId))
			.where(eq(payslips.runId, run.id));
		return { period: run.period, title: run.title, recipients };
	});
	const link = `${config().APP_URL}/t/${m.tenant.slug}/payslips`;
	await Promise.all(
		recipients.flatMap((r) =>
			r.email
				? [
						sendMail(
							{
								to: r.email,
								subject: `Your ${title ? `${title} ` : ''}payslip for ${period}`,
								text: [
									`Hello ${r.name},`,
									'',
									`Your ${title ? `${title} ` : ''}payslip for ${period} from ${m.tenant.name} is ready.`,
									`Open it here: ${link}`
								].join('\n')
							},
							`payslip-mail-${r.id}`
						)
					]
				: []
		)
	).catch((err) => log.warn({ tenantId: m.tenant.id, err: (err as Error).message }, 'payslip mails not queued'));
}

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
			runs: runs.map((r) => ({ id: r.id, period: r.period, title: r.title, status: r.status })),
			run: run && {
				...run,
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
		.select({ id: payrollRuns.id, period: payrollRuns.period, title: payrollRuns.title, at: payrollRuns.computedAt })
		.from(payrollRuns)
		.where(eq(payrollRuns.status, 'computed'))
		.orderBy(asc(payrollRuns.computedAt));
	return rows.map((r) => ({
		id: r.id,
		kind: 'Payroll',
		title: `${r.title ?? 'Payroll'} for ${r.period}`,
		requestedBy: 'Payroll',
		at: r.at,
		link: `payroll?run=${r.id}`
	}));
}

const paidSlip = (m: Member) =>
	and(eq(payslips.employeeId, m.access.employeeId ?? sql`null`), eq(payrollRuns.status, 'paid'));

export async function myPayslips(m: Member) {
	return withTenant(userCtx(m), (tx) =>
		tx
			.select({ id: payslips.id, period: payrollRuns.period, title: payrollRuns.title, net: payslips.net })
			.from(payslips)
			.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
			.where(paidSlip(m))
			.orderBy(desc(payrollRuns.period), desc(payrollRuns.paidAt))
	);
}

export async function openPayslipPdf(m: Member, payslipId: string) {
	const valid = z.uuid().safeParse(payslipId).success;
	return withTenant(userCtx(m), async (tx) => {
		const [slip] = valid
			? await tx
					.select({
						period: payrollRuns.period,
						title: payrollRuns.title,
						employee: employees.fullName,
						code: employees.code,
						paidDays: payslips.paidDays,
						unpaidDays: payslips.unpaidDays,
						gross: payslips.gross,
						deductions: payslips.deductions,
						rounding: payslips.rounding,
						net: payslips.net,
						notes: payslips.notes
					})
					.from(payslips)
					.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
					.innerJoin(employees, eq(employees.id, payslips.employeeId))
					.where(and(eq(payslips.id, payslipId), paidSlip(m)))
			: [];
		if (!slip) throw new AppError('not_found', 'That payslip does not exist.', 404);
		const lines = await tx
			.select({ name: payslipLines.name, kind: payslipLines.kind, amount: payslipLines.amount })
			.from(payslipLines)
			.where(eq(payslipLines.payslipId, payslipId))
			.orderBy(asc(payslipLines.seq));
		const [settings] = await tx.select({ legalName: tenantSettings.legalName }).from(tenantSettings);
		return {
			fileName: `${slip.title ? 'bonus' : 'payslip'}-${slip.period}.pdf`,
			body: await renderPayslipPdf({
				...slip,
				company: settings?.legalName ?? m.tenant.name,
				lines: lines.map((l) => ({ ...l, kind: l.kind as PayLine['kind'] }))
			})
		};
	});
}
