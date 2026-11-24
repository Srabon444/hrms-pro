import { sql } from 'drizzle-orm';
import { boolean, check, date, index, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { employees } from './org';

export const PROJECT_STATUSES = ['active', 'on_hold', 'closed'] as const;
export const PROJECT_ROLES = ['member', 'lead'] as const;
export const TIMESHEET_STATUSES = ['draft', 'submitted', 'approved', 'rejected'] as const;

export const projects = pgTable(
	'projects',
	{
		...tenantBase(),
		code: text().notNull(),
		name: text().notNull(),
		client: text().notNull().default(''),
		status: text().notNull().default('active'),
		billable: boolean().notNull().default(true),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('projects', t),
		unique('projects_code_uq').on(t.tenantId, t.code),
		check('projects_code_ck', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9-]{1,11}$'`),
		check('projects_name_ck', sql`length(trim(${t.name})) between 1 and 120`),
		check('projects_client_ck', sql`length(${t.client}) <= 120`),
		check('projects_status_ck', sql`${t.status} in ('active','on_hold','closed')`)
	]
);

export const projectMembers = pgTable(
	'project_members',
	{
		...tenantBase(),
		projectId: uuid().notNull(),
		employeeId: uuid().notNull(),
		role: text().notNull().default('member'),
		allocation: smallint().notNull().default(100)
	},
	(t) => [
		tenantKey('project_members', t),
		tfk('project_members_project_fk', t, t.projectId, projects, 'cascade'),
		tfk('project_members_employee_fk', t, t.employeeId, employees, 'cascade'),
		unique('project_members_uq').on(t.tenantId, t.projectId, t.employeeId),
		index('project_members_employee_idx').on(t.tenantId, t.employeeId),
		check('project_members_role_ck', sql`${t.role} in ('member','lead')`),
		check('project_members_allocation_ck', sql`${t.allocation} between 1 and 100`)
	]
);

export const timesheets = pgTable(
	'timesheets',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		weekStart: date().notNull(),
		status: text().notNull().default('draft'),
		submittedAt: tstz(),
		decidedByUserId: uuid(),
		decidedAt: tstz(),
		decisionNote: text()
	},
	(t) => [
		tenantKey('timesheets', t),
		tfk('timesheets_employee_fk', t, t.employeeId, employees, 'cascade'),
		unique('timesheets_week_uq').on(t.tenantId, t.employeeId, t.weekStart),
		index('timesheets_status_idx').on(t.tenantId, t.status),
		check('timesheets_status_ck', sql`${t.status} in ('draft','submitted','approved','rejected')`),
		check('timesheets_submitted_ck', sql`(${t.status} = 'draft') = (${t.submittedAt} is null)`),
		check('timesheets_decided_ck', sql`(${t.status} in ('approved','rejected')) = (${t.decidedAt} is not null)`),
		check('timesheets_note_ck', sql`length(${t.decisionNote}) <= 300`)
	]
);

export const timesheetEntries = pgTable(
	'timesheet_entries',
	{
		...tenantBase(),
		timesheetId: uuid().notNull(),
		projectId: uuid().notNull(),
		workDate: date().notNull(),
		minutes: smallint().notNull(),
		note: text().notNull().default('')
	},
	(t) => [
		tenantKey('timesheet_entries', t),
		tfk('timesheet_entries_sheet_fk', t, t.timesheetId, timesheets, 'cascade'),
		tfk('timesheet_entries_project_fk', t, t.projectId, projects, 'restrict'),
		unique('timesheet_entries_uq').on(t.tenantId, t.timesheetId, t.projectId, t.workDate),
		index('timesheet_entries_project_idx').on(t.tenantId, t.projectId, t.workDate),
		check('timesheet_entries_minutes_ck', sql`${t.minutes} between 15 and 1440 and ${t.minutes} % 15 = 0`),
		check('timesheet_entries_note_ck', sql`length(${t.note}) <= 300`)
	]
);
