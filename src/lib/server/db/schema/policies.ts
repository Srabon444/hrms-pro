import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { citext, tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { employees } from './org';

export const policies = pgTable(
	'policies',
	{
		...tenantBase(),
		title: citext().notNull(),
		description: text().notNull().default(''),
		version: integer().notNull().default(1),
		requiresAck: boolean().notNull().default(true),
		active: boolean().notNull().default(true),
		fileName: text().notNull(),
		contentType: text().notNull(),
		sizeBytes: integer().notNull(),
		sha256: text().notNull(),
		storageKey: text().notNull(),
		publishedOn: date().notNull(),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('policies', t),
		unique('policies_title_uq').on(t.tenantId, t.title),
		check('policies_title_ck', sql`length(trim(${t.title})) between 1 and 160`),
		check('policies_description_ck', sql`length(${t.description}) <= 2000`),
		check('policies_version_ck', sql`${t.version} >= 1`),
		check('policies_size_ck', sql`${t.sizeBytes} > 0`)
	]
);

export const policyAcknowledgements = pgTable(
	'policy_acknowledgements',
	{
		...tenantBase(),
		policyId: uuid().notNull(),
		employeeId: uuid().notNull(),
		version: integer().notNull(),
		sha256: text().notNull(),
		acknowledgedAt: tstz().notNull().defaultNow()
	},
	(t) => [
		tenantKey('policy_acknowledgements', t),
		tfk('policy_acknowledgements_policy_fk', t, t.policyId, policies, 'cascade'),
		tfk('policy_acknowledgements_employee_fk', t, t.employeeId, employees, 'cascade'),
		unique('policy_acknowledgements_uq').on(t.tenantId, t.policyId, t.employeeId, t.version),
		index('policy_acknowledgements_employee_idx').on(t.tenantId, t.employeeId)
	]
);
