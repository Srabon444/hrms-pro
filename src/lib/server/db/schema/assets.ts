import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk } from './_helpers';
import { employees } from './org';

export const ASSET_STATUSES = ['available', 'assigned', 'repair', 'retired', 'lost'] as const;
export const ASSET_CONDITIONS = ['new', 'good', 'fair', 'poor', 'damaged'] as const;
export const ASSET_OUTCOMES = ['returned', 'written_off'] as const;

export const assets = pgTable(
	'assets',
	{
		...tenantBase(),
		tag: text().notNull(),
		name: text().notNull(),
		category: text().notNull(),
		serial: text().notNull().default(''),
		purchaseDate: date(),
		purchaseCost: integer(),
		status: text().notNull().default('available'),
		notes: text().notNull().default(''),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('assets', t),
		unique('assets_tag_uq').on(t.tenantId, t.tag),
		index('assets_status_idx').on(t.tenantId, t.status),
		check('assets_tag_ck', sql`${t.tag} ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'`),
		check('assets_name_ck', sql`length(trim(${t.name})) between 1 and 120`),
		check('assets_category_ck', sql`length(trim(${t.category})) between 1 and 60`),
		check('assets_serial_ck', sql`length(${t.serial}) <= 120`),
		check('assets_cost_ck', sql`${t.purchaseCost} is null or ${t.purchaseCost} >= 0`),
		check('assets_status_ck', sql`${t.status} in ('available','assigned','repair','retired','lost')`),
		check('assets_notes_ck', sql`length(${t.notes}) <= 500`)
	]
);

export const assetAssignments = pgTable(
	'asset_assignments',
	{
		...tenantBase(),
		assetId: uuid().notNull(),
		employeeId: uuid().notNull(),
		assignedOn: date().notNull(),
		conditionOut: text().notNull(),
		assignedByUserId: uuid(),
		returnedOn: date(),
		conditionIn: text(),
		outcome: text(),
		charge: integer().notNull().default(0),
		returnNote: text().notNull().default(''),
		closedByUserId: uuid()
	},
	(t) => [
		tenantKey('asset_assignments', t),
		tfk('asset_assignments_asset_fk', t, t.assetId, assets, 'cascade'),
		tfk('asset_assignments_employee_fk', t, t.employeeId, employees, 'cascade'),
		uniqueIndex('asset_assignments_open_uq')
			.on(t.tenantId, t.assetId)
			.where(sql`${t.returnedOn} is null`),
		index('asset_assignments_employee_idx').on(t.tenantId, t.employeeId),
		check('asset_assignments_condition_out_ck', sql`${t.conditionOut} in ('new','good','fair','poor','damaged')`),
		check(
			'asset_assignments_closed_ck',
			sql`(${t.returnedOn} is null) = (${t.outcome} is null) and (${t.outcome} = 'returned') = (${t.conditionIn} is not null)`
		),
		check('asset_assignments_condition_in_ck', sql`${t.conditionIn} in ('new','good','fair','poor','damaged')`),
		check('asset_assignments_outcome_ck', sql`${t.outcome} in ('returned','written_off')`),
		check('asset_assignments_dates_ck', sql`${t.returnedOn} >= ${t.assignedOn}`),
		check('asset_assignments_charge_ck', sql`${t.charge} >= 0 and (${t.outcome} is not null or ${t.charge} = 0)`),
		check('asset_assignments_note_ck', sql`length(${t.returnNote}) <= 300`)
	]
);
