import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	integer,
	pgTable,
	smallint,
	text,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { employees } from './org';

export const MEAL_MODES = ['opt_out', 'opt_in'] as const;
export const MEAL_BILLING_MODES = ['payroll', 'direct'] as const;
export const MEAL_ORDER_STATUSES = ['ordered', 'opted_out', 'auto_off'] as const;
export const MEAL_PAYMENT_METHODS = ['cash', 'bank', 'mobile'] as const;
export const MEAL_BILL_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'deducted', 'void'] as const;

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

export const mealOrders = pgTable(
	'meal_orders',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		date: date({ mode: 'string' }).notNull(),
		mealTypeId: uuid().notNull(),
		status: text().notNull(),
		guestQty: smallint().notNull().default(0),
		unitCost: integer(),
		subsidyPct: smallint(),
		updatedByUserId: uuid()
	},
	(t) => [
		tenantKey('meal_orders', t),
		tfk('meal_orders_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('meal_orders_type_fk', t, t.mealTypeId, mealTypes, 'restrict'),
		unique('meal_orders_day_uq').on(t.tenantId, t.employeeId, t.date, t.mealTypeId),
		check('meal_orders_status_ck', sql`${t.status} in ('ordered','opted_out','auto_off')`),
		check('meal_orders_guests_ck', sql`${t.guestQty} between 0 and 10`),
		check('meal_orders_price_ck', sql`(${t.unitCost} is null) = (${t.subsidyPct} is null)`)
	]
);

export const mealDays = pgTable(
	'meal_days',
	{
		...tenantBase(),
		date: date({ mode: 'string' }).notNull(),
		locked: boolean().notNull().default(false),
		lockedAt: tstz(),
		lockedByUserId: uuid()
	},
	(t) => [tenantKey('meal_days', t), unique('meal_days_date_uq').on(t.tenantId, t.date)]
);

export const mealBills = pgTable(
	'meal_bills',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		period: text().notNull(),
		status: text().notNull().default('draft'),
		billingMode: text().notNull(),
		total: integer().notNull(),
		paid: integer().notNull().default(0),
		issuedAt: tstz(),
		issuedByUserId: uuid(),
		payrollRunId: uuid(),
		pdfKey: text()
	},
	(t) => [
		tenantKey('meal_bills', t),
		tfk('meal_bills_employee_fk', t, t.employeeId, employees, 'restrict'),
		uniqueIndex('meal_bills_period_uq')
			.on(t.tenantId, t.employeeId, t.period)
			.where(sql`${t.status} <> 'void'`),
		check('meal_bills_period_ck', sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
		check('meal_bills_status_ck', sql`${t.status} in ('draft','issued','partially_paid','paid','deducted','void')`),
		check('meal_bills_mode_ck', sql`${t.billingMode} in ('payroll','direct')`),
		check('meal_bills_paid_ck', sql`${t.paid} >= 0 and ${t.paid} <= greatest(${t.total}, 0)`)
	]
);

export const mealBillLines = pgTable(
	'meal_bill_lines',
	{
		...tenantBase(),
		billId: uuid().notNull(),
		orderId: uuid().notNull(),
		kind: text().notNull(),
		date: date({ mode: 'string' }).notNull(),
		meal: text().notNull(),
		plates: smallint().notNull(),
		guests: smallint().notNull(),
		unitCost: integer().notNull(),
		subsidyPct: smallint().notNull(),
		amount: integer().notNull()
	},
	(t) => [
		tenantKey('meal_bill_lines', t),
		tfk('meal_bill_lines_bill_fk', t, t.billId, mealBills, 'cascade'),
		tfk('meal_bill_lines_order_fk', t, t.orderId, mealOrders, 'restrict'),
		index('meal_bill_lines_bill_ix').on(t.tenantId, t.billId),
		index('meal_bill_lines_order_ix').on(t.tenantId, t.orderId),
		check('meal_bill_lines_kind_ck', sql`${t.kind} in ('meal','adjustment')`)
	]
);

export const mealPayments = pgTable(
	'meal_payments',
	{
		...tenantBase(),
		billId: uuid().notNull(),
		amount: integer().notNull(),
		paidOn: date({ mode: 'string' }).notNull(),
		method: text().notNull(),
		note: text(),
		recordedByUserId: uuid()
	},
	(t) => [
		tenantKey('meal_payments', t),
		tfk('meal_payments_bill_fk', t, t.billId, mealBills, 'restrict'),
		index('meal_payments_bill_ix').on(t.tenantId, t.billId),
		check('meal_payments_amount_ck', sql`${t.amount} > 0`),
		check('meal_payments_method_ck', sql`${t.method} in ('cash','bank','mobile')`),
		check('meal_payments_note_ck', sql`${t.note} is null or length(${t.note}) <= 200`)
	]
);
