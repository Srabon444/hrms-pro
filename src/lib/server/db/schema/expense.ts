import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tfk, tenantBase, tenantKey, trigramIndex, tstz } from './_helpers';
import { employees } from './org';
import { payrollRuns } from './payroll';
import { travelRequests } from './travel';

export const EXPENSE_STATUSES = ['submitted', 'approved', 'rejected', 'paid', 'cancelled'] as const;
export const EXPENSE_PAY_VIA = ['payroll', 'direct'] as const;
export const MAX_EXPENSE_ITEMS = 10;

export const expenseCategories = pgTable(
	'expense_categories',
	{
		...tenantBase(),
		name: text().notNull(),
		claimLimit: integer(),
		active: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('expense_categories', t),
		unique('expense_categories_name_uq').on(t.tenantId, t.name),
		check('expense_categories_name_ck', sql`length(trim(${t.name})) between 1 and 60`),
		check('expense_categories_limit_ck', sql`${t.claimLimit} is null or ${t.claimLimit} > 0`)
	]
);

export const expenseClaims = pgTable(
	'expense_claims',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		title: text().notNull(),
		status: text().notNull().default('submitted'),
		total: integer().notNull(),
		payVia: text(),
		submittedByUserId: uuid().notNull(),
		decidedByUserId: uuid(),
		decidedAt: tstz(),
		decisionNote: text(),
		paidAt: tstz(),
		paidByUserId: uuid(),
		payrollRunId: uuid(),
		travelRequestId: uuid()
	},
	(t) => [
		tenantKey('expense_claims', t),
		tfk('expense_claims_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('expense_claims_run_fk', t, t.payrollRunId, payrollRuns),
		tfk('expense_claims_trip_fk', t, t.travelRequestId, travelRequests, 'restrict'),
		index('expense_claims_trip_idx').on(t.tenantId, t.travelRequestId),
		index('expense_claims_employee_idx').on(t.tenantId, t.employeeId),
		index('expense_claims_status_idx').on(t.tenantId, t.status),
		trigramIndex('expense_claims_search_idx', t, t.title),
		check('expense_claims_title_ck', sql`length(trim(${t.title})) between 1 and 120`),
		check('expense_claims_status_ck', sql`${t.status} in ('submitted','approved','rejected','paid','cancelled')`),
		check('expense_claims_pay_via_ck', sql`${t.payVia} is null or ${t.payVia} in ('payroll','direct')`),
		check('expense_claims_note_ck', sql`${t.decisionNote} is null or length(${t.decisionNote}) <= 300`),
		check('expense_claims_total_ck', sql`${t.total} > 0`)
	]
);

export const expenseItems = pgTable(
	'expense_items',
	{
		...tenantBase(),
		claimId: uuid().notNull(),
		categoryId: uuid().notNull(),
		spentOn: date().notNull(),
		description: text().notNull(),
		amount: integer().notNull(),
		receiptKey: text(),
		receiptName: text(),
		receiptType: text(),
		receiptSize: integer()
	},
	(t) => [
		tenantKey('expense_items', t),
		tfk('expense_items_claim_fk', t, t.claimId, expenseClaims, 'cascade'),
		tfk('expense_items_category_fk', t, t.categoryId, expenseCategories, 'restrict'),
		index('expense_items_claim_idx').on(t.tenantId, t.claimId),
		index('expense_items_category_idx').on(t.tenantId, t.categoryId),
		check('expense_items_description_ck', sql`length(trim(${t.description})) between 1 and 200`),
		check('expense_items_amount_ck', sql`${t.amount} > 0`)
	]
);
