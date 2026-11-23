import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	pgTable,
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
