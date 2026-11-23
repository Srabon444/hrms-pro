import { sql } from 'drizzle-orm';
import { boolean, check, date, integer, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk } from './_helpers';

export const MEAL_MODES = ['opt_out', 'opt_in'] as const;
export const MEAL_BILLING_MODES = ['payroll', 'direct'] as const;

export const mealVendors = pgTable(
	'meal_vendors',
	{
		...tenantBase(),
		name: text().notNull(),
		contact: text(),
		active: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('meal_vendors', t),
		unique('meal_vendors_name_uq').on(t.tenantId, t.name),
		check('meal_vendors_name_ck', sql`length(trim(${t.name})) between 1 and 100`),
		check('meal_vendors_contact_ck', sql`${t.contact} is null or length(${t.contact}) <= 200`)
	]
);

export const mealTypes = pgTable(
	'meal_types',
	{
		...tenantBase(),
		name: text().notNull(),
		vendorId: uuid().notNull(),
		active: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('meal_types', t),
		tfk('meal_types_vendor_fk', t, t.vendorId, mealVendors, 'restrict'),
		unique('meal_types_name_uq').on(t.tenantId, t.name),
		check('meal_types_name_ck', sql`length(trim(${t.name})) between 1 and 60`)
	]
);

export const mealTypePrices = pgTable(
	'meal_type_prices',
	{
		...tenantBase(),
		mealTypeId: uuid().notNull(),
		effectiveFrom: date({ mode: 'string' }).notNull(),
		unitCost: integer().notNull(),
		subsidyPct: smallint().notNull().default(0)
	},
	(t) => [
		tenantKey('meal_type_prices', t),
		tfk('meal_type_prices_type_fk', t, t.mealTypeId, mealTypes, 'cascade'),
		unique('meal_type_prices_from_uq').on(t.tenantId, t.mealTypeId, t.effectiveFrom),
		check('meal_type_prices_cost_ck', sql`${t.unitCost} between 1 and 1000000`),
		check('meal_type_prices_subsidy_ck', sql`${t.subsidyPct} between 0 and 100`)
	]
);
