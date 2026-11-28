import { sql } from 'drizzle-orm';
import { check, date, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk } from './_helpers';
import { departments, employees } from './org';
import { salaryChanges } from './payroll';

export const COMP_CYCLE_STATUSES = ['open', 'closed'] as const;
export const COMP_PROPOSAL_STATUSES = ['proposed', 'applied'] as const;

export const compCycles = pgTable(
	'comp_cycles',
	{
		...tenantBase(),
		name: text().notNull(),
		effectiveFrom: date().notNull(),
		status: text({ enum: COMP_CYCLE_STATUSES }).notNull().default('open'),
		guidelineBp: integer(),
		createdByUserId: uuid().notNull()
	},
	(t) => [
		tenantKey('comp_cycles', t),
		unique('comp_cycles_name_uq').on(t.tenantId, t.name),
		check('comp_cycles_name_ck', sql`length(trim(${t.name})) between 1 and 80`),
		check('comp_cycles_status_ck', sql`${t.status} in ('open','closed')`),
		check('comp_cycles_guideline_ck', sql`${t.guidelineBp} is null or ${t.guidelineBp} between 1 and 10000`)
	]
);

export const compBudgets = pgTable(
	'comp_budgets',
	{
		...tenantBase(),
		cycleId: uuid().notNull(),
		departmentId: uuid().notNull(),
		budget: integer().notNull()
	},
	(t) => [
		tenantKey('comp_budgets', t),
		tfk('comp_budgets_cycle_fk', t, t.cycleId, compCycles, 'cascade'),
		tfk('comp_budgets_department_fk', t, t.departmentId, departments, 'cascade'),
		unique('comp_budgets_department_uq').on(t.tenantId, t.cycleId, t.departmentId),
		check('comp_budgets_budget_ck', sql`${t.budget} between 0 and 999999999`)
	]
);

export const compProposals = pgTable(
	'comp_proposals',
	{
		...tenantBase(),
		cycleId: uuid().notNull(),
		employeeId: uuid().notNull(),
		currentGross: integer().notNull(),
		changeBp: integer().notNull(),
		proposedGross: integer().notNull(),
		reason: text().notNull(),
		proposedByUserId: uuid().notNull(),
		status: text({ enum: COMP_PROPOSAL_STATUSES }).notNull().default('proposed'),
		salaryChangeId: uuid()
	},
	(t) => [
		tenantKey('comp_proposals', t),
		tfk('comp_proposals_cycle_fk', t, t.cycleId, compCycles, 'cascade'),
		tfk('comp_proposals_employee_fk', t, t.employeeId, employees, 'cascade'),
		tfk('comp_proposals_change_fk', t, t.salaryChangeId, salaryChanges, 'restrict'),
		unique('comp_proposals_employee_uq').on(t.tenantId, t.cycleId, t.employeeId),
		check('comp_proposals_change_bp_ck', sql`${t.changeBp} between 1 and 10000`),
		check('comp_proposals_gross_ck', sql`${t.currentGross} > 0 and ${t.proposedGross} > 0`),
		check('comp_proposals_reason_ck', sql`length(trim(${t.reason})) between 1 and 200`),
		check('comp_proposals_status_ck', sql`${t.status} in ('proposed','applied')`),
		check('comp_proposals_applied_ck', sql`(${t.status} = 'applied') = (${t.salaryChangeId} is not null)`)
	]
);
