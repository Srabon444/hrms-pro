import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { employees } from './org';

export const LOAN_KINDS = ['loan', 'advance'] as const;
export const LOAN_STATUSES = ['requested', 'approved', 'rejected', 'cancelled', 'closed'] as const;
export const MAX_INSTALMENTS = 60;

const PERIOD = (col: unknown) => sql`${col} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`;

export const loans = pgTable(
	'loans',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		kind: text().notNull(),
		amount: integer().notNull(),
		instalments: integer().notNull(),
		startPeriod: text().notNull(),
		reason: text().notNull(),
		status: text().notNull().default('requested'),
		requestedByUserId: uuid().notNull(),
		decidedByUserId: uuid(),
		decidedAt: tstz(),
		decisionNote: text()
	},
	(t) => [
		tenantKey('loans', t),
		tfk('loans_employee_fk', t, t.employeeId, employees, 'restrict'),
		index('loans_employee_idx').on(t.tenantId, t.employeeId),
		uniqueIndex('loans_requested_uq')
			.on(t.tenantId, t.employeeId)
			.where(sql`${t.status} = 'requested'`),
		check('loans_kind_ck', sql`${t.kind} in ('loan','advance')`),
		check('loans_status_ck', sql`${t.status} in ('requested','approved','rejected','cancelled','closed')`),
		check('loans_amount_ck', sql`${t.amount} > 0`),
		check('loans_instalments_ck', sql`${t.instalments} between 1 and ${sql.raw(String(MAX_INSTALMENTS))}`),
		check('loans_start_ck', PERIOD(t.startPeriod)),
		check('loans_reason_ck', sql`length(trim(${t.reason})) between 1 and 300`),
		check('loans_note_ck', sql`${t.decisionNote} is null or length(${t.decisionNote}) <= 300`)
	]
);

export const loanInstalments = pgTable(
	'loan_instalments',
	{
		...tenantBase(),
		loanId: uuid().notNull(),
		employeeId: uuid().notNull(),
		period: text().notNull(),
		amount: integer().notNull(),
		status: text().notNull().default('due'),
		payrollRunId: uuid(),
		paidAt: tstz()
	},
	(t) => [
		tenantKey('loan_instalments', t),
		tfk('loan_instalments_loan_fk', t, t.loanId, loans, 'cascade'),
		tfk('loan_instalments_employee_fk', t, t.employeeId, employees, 'restrict'),
		unique('loan_instalments_period_uq').on(t.tenantId, t.loanId, t.period),
		index('loan_instalments_due_idx').on(t.tenantId, t.employeeId, t.period),
		check('loan_instalments_period_ck', PERIOD(t.period)),
		check('loan_instalments_amount_ck', sql`${t.amount} > 0`),
		check('loan_instalments_status_ck', sql`${t.status} in ('due','paid')`)
	]
);
