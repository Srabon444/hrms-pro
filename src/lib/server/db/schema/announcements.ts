import { sql } from 'drizzle-orm';
import { boolean, check, date, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk } from './_helpers';
import { branches, departments } from './org';

export const ANNOUNCEMENT_AUDIENCES = ['all', 'department', 'branch'] as const;

export const announcements = pgTable(
	'announcements',
	{
		...tenantBase(),
		title: text().notNull(),
		body: text().notNull(),
		audience: text().notNull().default('all'),
		departmentId: uuid(),
		branchId: uuid(),
		pinned: boolean().notNull().default(false),
		publishOn: date().notNull(),
		expiresOn: date(),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('announcements', t),
		tfk('announcements_department_fk', t, t.departmentId, departments, 'cascade'),
		tfk('announcements_branch_fk', t, t.branchId, branches, 'cascade'),
		index('announcements_publish_idx').on(t.tenantId, t.publishOn),
		check('announcements_title_ck', sql`length(trim(${t.title})) between 1 and 160`),
		check('announcements_body_ck', sql`length(trim(${t.body})) between 1 and 5000`),
		check(
			'announcements_audience_ck',
			sql`(${t.audience} = 'all' and ${t.departmentId} is null and ${t.branchId} is null) or (${t.audience} = 'department' and ${t.departmentId} is not null and ${t.branchId} is null) or (${t.audience} = 'branch' and ${t.branchId} is not null and ${t.departmentId} is null)`
		),
		check('announcements_window_ck', sql`${t.expiresOn} >= ${t.publishOn}`)
	]
);
