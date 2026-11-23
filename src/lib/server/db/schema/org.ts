import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk } from './_helpers';

const nameCheck = (table: string, col: unknown) =>
	check(`${table}_name_ck`, sql`length(trim(${col})) between 1 and 120`);

export const branches = pgTable('branches', { ...tenantBase(), name: text().notNull(), address: text() }, (t) => [
	tenantKey('branches', t),
	unique('branches_name_uq').on(t.tenantId, t.name),
	nameCheck('branches', t.name)
]);

export const departments = pgTable(
	'departments',
	{ ...tenantBase(), name: text().notNull(), parentId: uuid() },
	(t) => [
		tenantKey('departments', t),
		unique('departments_name_uq').on(t.tenantId, t.name),
		tfk('departments_parent_fk', t, t.parentId, t, 'restrict'),
		index('departments_parent_idx').on(t.tenantId, t.parentId),
		check('departments_not_own_parent_ck', sql`${t.parentId} is distinct from ${t.id}`),
		nameCheck('departments', t.name)
	]
);

export const designations = pgTable('designations', { ...tenantBase(), name: text().notNull() }, (t) => [
	tenantKey('designations', t),
	unique('designations_name_uq').on(t.tenantId, t.name),
	nameCheck('designations', t.name)
]);

export const grades = pgTable(
	'grades',
	{ ...tenantBase(), name: text().notNull(), rank: smallint().notNull().default(0) },
	(t) => [tenantKey('grades', t), unique('grades_name_uq').on(t.tenantId, t.name), nameCheck('grades', t.name)]
);

export const holidays = pgTable(
	'holidays',
	{ ...tenantBase(), date: date({ mode: 'string' }).notNull(), name: text().notNull() },
	(t) => [tenantKey('holidays', t), unique('holidays_date_uq').on(t.tenantId, t.date), nameCheck('holidays', t.name)]
);
