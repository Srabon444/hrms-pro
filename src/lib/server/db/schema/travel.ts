import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { loans } from './loan';
import { employees } from './org';

export const TRAVEL_STATUSES = ['submitted', 'approved', 'rejected', 'cancelled'] as const;

export const travelRequests = pgTable(
	'travel_requests',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		purpose: text().notNull(),
		country: text().notNull(),
		city: text(),
		departOn: date().notNull(),
		returnOn: date().notNull(),
		estimatedCost: integer().notNull(),
		advance: integer().notNull().default(0),
		status: text({ enum: TRAVEL_STATUSES }).notNull().default('submitted'),
		requestedByUserId: uuid().notNull(),
		decidedByUserId: uuid(),
		decidedAt: tstz(),
		decisionNote: text(),
		loanId: uuid()
	},
	(t) => [
		tenantKey('travel_requests', t),
		tfk('travel_requests_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('travel_requests_loan_fk', t, t.loanId, loans, 'restrict'),
		index('travel_requests_employee_idx').on(t.tenantId, t.employeeId),
		check('travel_requests_purpose_ck', sql`length(trim(${t.purpose})) between 1 and 200`),
		check('travel_requests_country_ck', sql`length(trim(${t.country})) between 1 and 60`),
		check('travel_requests_city_ck', sql`${t.city} is null or length(trim(${t.city})) between 1 and 60`),
		check('travel_requests_dates_ck', sql`${t.returnOn} >= ${t.departOn}`),
		check('travel_requests_cost_ck', sql`${t.estimatedCost} between 0 and 999999999`),
		check('travel_requests_advance_ck', sql`${t.advance} between 0 and ${t.estimatedCost}`),
		check('travel_requests_status_ck', sql`${t.status} in ('submitted','approved','rejected','cancelled')`),
		check('travel_requests_note_ck', sql`${t.decisionNote} is null or length(${t.decisionNote}) <= 300`)
	]
);

export const perDiemRates = pgTable(
	'per_diem_rates',
	{
		...tenantBase(),
		country: text().notNull(),
		city: text(),
		dailyAmount: integer().notNull()
	},
	(t) => [
		tenantKey('per_diem_rates', t),
		uniqueIndex('per_diem_rates_place_uq').on(
			t.tenantId,
			sql`lower(${t.country})`,
			sql`lower(coalesce(${t.city}, ''))`
		),
		check('per_diem_rates_country_ck', sql`length(trim(${t.country})) between 1 and 60`),
		check('per_diem_rates_city_ck', sql`${t.city} is null or length(trim(${t.city})) between 1 and 60`),
		check('per_diem_rates_amount_ck', sql`${t.dailyAmount} between 1 and 99999999`)
	]
);
