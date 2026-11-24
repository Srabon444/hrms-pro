import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { citext, tenantBase, tenantKey, tfk } from './_helpers';
import { employees } from './org';

export const LETTER_KINDS = [
	'offer',
	'appointment',
	'confirmation',
	'increment',
	'experience',
	'salary_certificate',
	'other'
] as const;

const kindCheck = (table: string, col: unknown) =>
	check(
		`${table}_kind_ck`,
		sql`${col} in ('offer','appointment','confirmation','increment','experience','salary_certificate','other')`
	);

export const letterTemplates = pgTable(
	'letter_templates',
	{
		...tenantBase(),
		kind: text().notNull(),
		name: citext().notNull(),
		subject: text().notNull(),
		body: text().notNull(),
		active: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('letter_templates', t),
		unique('letter_templates_name_uq').on(t.tenantId, t.name),
		kindCheck('letter_templates', t.kind),
		check('letter_templates_name_ck', sql`length(trim(${t.name})) between 1 and 80`),
		check('letter_templates_subject_ck', sql`length(trim(${t.subject})) between 1 and 160`),
		check('letter_templates_body_ck', sql`length(trim(${t.body})) between 1 and 20000`)
	]
);

export const letters = pgTable(
	'letters',
	{
		...tenantBase(),
		number: integer().notNull(),
		employeeId: uuid().notNull(),
		templateId: uuid().notNull(),
		kind: text().notNull(),
		subject: text().notNull(),
		body: text().notNull(),
		fileName: text().notNull(),
		sizeBytes: integer().notNull(),
		sha256: text().notNull(),
		storageKey: text().notNull(),
		issuedOn: date().notNull(),
		issuedByUserId: uuid()
	},
	(t) => [
		tenantKey('letters', t),
		unique('letters_number_uq').on(t.tenantId, t.number),
		tfk('letters_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('letters_template_fk', t, t.templateId, letterTemplates, 'restrict'),
		index('letters_employee_idx').on(t.tenantId, t.employeeId),
		kindCheck('letters', t.kind),
		check('letters_number_ck', sql`${t.number} > 0`),
		check('letters_subject_ck', sql`length(trim(${t.subject})) between 1 and 160`),
		check('letters_body_ck', sql`length(trim(${t.body})) between 1 and 20000`),
		check('letters_size_ck', sql`${t.sizeBytes} > 0`)
	]
);
