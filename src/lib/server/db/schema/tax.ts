import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { employees } from './org';

const CATEGORY = (col: unknown) => sql`${col} in ('general','female_senior','disabled','freedom_fighter')`;

export const taxYears = pgTable(
	'tax_years',
	{
		...tenantBase(),
		fy: text().notNull(),
		minimumTax: integer().notNull(),
		exemptionCap: integer().notNull(),
		exemptionDivisor: integer().notNull(),
		confirmedByUserId: uuid(),
		confirmedAt: tstz()
	},
	(t) => [
		tenantKey('tax_years', t),
		unique('tax_years_fy_uq').on(t.tenantId, t.fy),
		check('tax_years_fy_ck', sql`${t.fy} ~ '^[0-9]{4}-[0-9]{2}$'`),
		check('tax_years_minimum_ck', sql`${t.minimumTax} >= 0`),
		check('tax_years_cap_ck', sql`${t.exemptionCap} >= 0`),
		check('tax_years_divisor_ck', sql`${t.exemptionDivisor} between 1 and 10`)
	]
);

export const taxSlabs = pgTable(
	'tax_slabs',
	{
		...tenantBase(),
		taxYearId: uuid().notNull(),
		category: text().notNull(),
		seq: integer().notNull(),
		width: integer(),
		rateBp: integer().notNull()
	},
	(t) => [
		tenantKey('tax_slabs', t),
		tfk('tax_slabs_year_fk', t, t.taxYearId, taxYears, 'cascade'),
		unique('tax_slabs_seq_uq').on(t.tenantId, t.taxYearId, t.category, t.seq),
		check('tax_slabs_category_ck', CATEGORY(t.category)),
		check('tax_slabs_width_ck', sql`${t.width} is null or ${t.width} > 0`),
		check('tax_slabs_rate_ck', sql`${t.rateBp} between 0 and 10000`)
	]
);

export const employeeTaxProfiles = pgTable(
	'employee_tax_profiles',
	{
		...tenantBase(),
		taxYearId: uuid().notNull(),
		employeeId: uuid().notNull(),
		category: text().notNull(),
		prevEmployerIncome: integer().notNull().default(0),
		prevTaxPaid: integer().notNull().default(0),
		rebate: integer().notNull().default(0)
	},
	(t) => [
		tenantKey('employee_tax_profiles', t),
		tfk('employee_tax_profiles_year_fk', t, t.taxYearId, taxYears, 'cascade'),
		tfk('employee_tax_profiles_employee_fk', t, t.employeeId, employees, 'restrict'),
		unique('employee_tax_profiles_uq').on(t.tenantId, t.taxYearId, t.employeeId),
		check('employee_tax_profiles_category_ck', CATEGORY(t.category)),
		check(
			'employee_tax_profiles_amounts_ck',
			sql`${t.prevEmployerIncome} >= 0 and ${t.prevTaxPaid} >= 0 and ${t.rebate} >= 0`
		)
	]
);
