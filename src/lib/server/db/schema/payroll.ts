import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	smallint,
	text,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { employees } from './org';

export const PAY_COMPONENT_KINDS = ['earning', 'deduction'] as const;
export const PAY_COMPONENT_CALCS = ['fixed', 'pct_basic'] as const;
export const SALARY_CHANGE_STATUSES = ['pending', 'approved', 'rejected'] as const;

export const payComponents = pgTable(
	'pay_components',
	{
		...tenantBase(),
		code: text().notNull(),
		name: text().notNull(),
		kind: text().notNull(),
		calc: text().notNull().default('fixed'),
		taxable: boolean().notNull().default(true),
		system: boolean().notNull().default(false),
		active: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('pay_components', t),
		unique('pay_components_code_uq').on(t.tenantId, t.code),
		unique('pay_components_name_uq').on(t.tenantId, t.name),
		check('pay_components_code_ck', sql`${t.code} ~ '^[A-Z][A-Z0-9_]{1,19}$'`),
		check('pay_components_name_ck', sql`length(trim(${t.name})) between 1 and 60`),
		check('pay_components_kind_ck', sql`${t.kind} in ('earning','deduction')`),
		check('pay_components_calc_ck', sql`${t.calc} in ('fixed','pct_basic')`)
	]
);

export const salaryChanges = pgTable(
	'salary_changes',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		effectiveFrom: date().notNull(),
		reason: text().notNull(),
		status: text().notNull().default('pending'),
		lines: jsonb().$type<{ componentId: string; value: number; amount: number }[]>().notNull(),
		gross: integer().notNull(),
		requestedByUserId: uuid().notNull(),
		decidedByUserId: uuid(),
		decidedAt: tstz(),
		decisionNote: text()
	},
	(t) => [
		tenantKey('salary_changes', t),
		tfk('salary_changes_employee_fk', t, t.employeeId, employees, 'restrict'),
		uniqueIndex('salary_changes_pending_uq')
			.on(t.tenantId, t.employeeId)
			.where(sql`${t.status} = 'pending'`),
		check('salary_changes_status_ck', sql`${t.status} in ('pending','approved','rejected')`),
		check('salary_changes_reason_ck', sql`length(trim(${t.reason})) between 1 and 300`),
		check('salary_changes_note_ck', sql`${t.decisionNote} is null or length(${t.decisionNote}) <= 300`),
		check('salary_changes_gross_ck', sql`${t.gross} > 0`)
	]
);

export const employeeSalaries = pgTable(
	'employee_salaries',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		effectiveFrom: date().notNull(),
		effectiveTo: date(),
		gross: integer().notNull(),
		changeId: uuid().notNull()
	},
	(t) => [
		tenantKey('employee_salaries', t),
		tfk('employee_salaries_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('employee_salaries_change_fk', t, t.changeId, salaryChanges, 'restrict'),
		unique('employee_salaries_change_uq').on(t.tenantId, t.changeId),
		check('employee_salaries_range_ck', sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
		check('employee_salaries_gross_ck', sql`${t.gross} > 0`)
	]
);

export const employeeSalaryLines = pgTable(
	'employee_salary_lines',
	{
		...tenantBase(),
		salaryId: uuid().notNull(),
		employeeId: uuid().notNull(),
		componentId: uuid().notNull(),
		value: integer().notNull(),
		amount: integer().notNull()
	},
	(t) => [
		tenantKey('employee_salary_lines', t),
		tfk('employee_salary_lines_salary_fk', t, t.salaryId, employeeSalaries, 'cascade'),
		tfk('employee_salary_lines_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('employee_salary_lines_component_fk', t, t.componentId, payComponents, 'restrict'),
		unique('employee_salary_lines_uq').on(t.tenantId, t.salaryId, t.componentId),
		index('employee_salary_lines_component_idx').on(t.tenantId, t.componentId),
		check('employee_salary_lines_value_ck', sql`${t.value} >= 0 and ${t.amount} >= 0`)
	]
);

export const PAYROLL_RUN_TYPES = ['regular', 'bonus', 'arrears', 'final'] as const;
export const PAYROLL_RUN_STATUSES = ['computed', 'approved', 'paid', 'void'] as const;

export const payrollRuns = pgTable(
	'payroll_runs',
	{
		...tenantBase(),
		runType: text().notNull().default('regular'),
		title: text(),
		period: text().notNull(),
		employeeId: uuid(),
		noticePayDays: smallint().notNull().default(0),
		noticeShortDays: smallint().notNull().default(0),
		assetDeduction: integer().notNull().default(0),
		settings: jsonb(),
		status: text().notNull().default('computed'),
		inputsHash: text().notNull(),
		outputHash: text().notNull(),
		computedByUserId: uuid().notNull(),
		computedAt: tstz().notNull(),
		approvedByUserId: uuid(),
		approvedAt: tstz(),
		paidByUserId: uuid(),
		paidAt: tstz()
	},
	(t) => [
		tenantKey('payroll_runs', t),
		tfk('payroll_runs_employee_fk', t, t.employeeId, employees, 'restrict'),
		uniqueIndex('payroll_runs_final_uq')
			.on(t.tenantId, t.employeeId)
			.where(sql`${t.runType} = 'final' and ${t.status} <> 'void'`),
		uniqueIndex('payroll_runs_regular_uq')
			.on(t.tenantId, t.period)
			.where(sql`${t.runType} = 'regular' and ${t.status} <> 'void'`),
		check('payroll_runs_period_ck', sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
		check('payroll_runs_type_ck', sql`${t.runType} in ('regular','bonus','arrears','final')`),
		check('payroll_runs_status_ck', sql`${t.status} in ('computed','approved','paid','void')`),
		check(
			'payroll_runs_final_ck',
			sql`(${t.runType} = 'final') = (${t.employeeId} is not null) and ${t.noticePayDays} between 0 and 365 and ${t.noticeShortDays} between 0 and 365 and (${t.noticePayDays} = 0 or ${t.noticeShortDays} = 0) and ${t.assetDeduction} >= 0 and (${t.runType} = 'final' or ${t.noticePayDays} + ${t.noticeShortDays} + ${t.assetDeduction} = 0)`
		),
		check(
			'payroll_runs_title_ck',
			sql`(${t.runType} = 'bonus') = (${t.title} is not null) and (${t.title} is null or length(trim(${t.title})) between 1 and 60)`
		)
	]
);

export const payslips = pgTable(
	'payslips',
	{
		...tenantBase(),
		runId: uuid().notNull(),
		employeeId: uuid().notNull(),
		paidDays: integer().notNull().default(0),
		unpaidDays: numeric({ precision: 5, scale: 1, mode: 'number' }).notNull().default(0),
		gross: integer().notNull().default(0),
		deductions: integer().notNull().default(0),
		rounding: integer().notNull().default(0),
		net: integer().notNull().default(0),
		taxable: integer().notNull().default(0),
		tax: integer().notNull().default(0),
		error: text(),
		notes: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`)
	},
	(t) => [
		tenantKey('payslips', t),
		tfk('payslips_run_fk', t, t.runId, payrollRuns, 'cascade'),
		tfk('payslips_employee_fk', t, t.employeeId, employees, 'restrict'),
		unique('payslips_run_employee_uq').on(t.tenantId, t.runId, t.employeeId),
		index('payslips_employee_idx').on(t.tenantId, t.employeeId),
		check('payslips_net_ck', sql`${t.net} >= 0`)
	]
);

export const payslipLines = pgTable(
	'payslip_lines',
	{
		...tenantBase(),
		payslipId: uuid().notNull(),
		employeeId: uuid().notNull(),
		seq: smallint().notNull(),
		code: text().notNull(),
		name: text().notNull(),
		kind: text().notNull(),
		taxable: boolean().notNull(),
		amount: integer().notNull(),
		forPeriod: text()
	},
	(t) => [
		tenantKey('payslip_lines', t),
		tfk('payslip_lines_payslip_fk', t, t.payslipId, payslips, 'cascade'),
		tfk('payslip_lines_employee_fk', t, t.employeeId, employees, 'restrict'),
		unique('payslip_lines_seq_uq').on(t.tenantId, t.payslipId, t.seq),
		check('payslip_lines_kind_ck', sql`${t.kind} in ('earning','deduction','employer')`),
		check('payslip_lines_amount_ck', sql`${t.amount} > 0`),
		check('payslip_lines_for_period_ck', sql`${t.forPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`)
	]
);
