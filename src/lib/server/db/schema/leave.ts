import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	numeric,
	pgTable,
	smallint,
	text,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk } from './_helpers';
import { employees } from './org';

export const LEAVE_ACCRUALS = ['yearly', 'monthly', 'none'] as const;
export const LEAVE_GENDERS = ['female', 'male'] as const;
export const LEDGER_KINDS = ['accrual', 'taken', 'adjustment', 'carry', 'expiry', 'encash', 'comp_credit'] as const;

const days = () => numeric({ precision: 5, scale: 1, mode: 'number' });

export const leaveTypes = pgTable(
	'leave_types',
	{
		...tenantBase(),
		code: text().notNull(),
		name: text().notNull(),
		paid: boolean().notNull().default(true),
		quota: days(),
		accrual: text().notNull().default('yearly'),
		proRata: boolean().notNull().default(true),
		carryCap: days().notNull().default(0),
		encashable: boolean().notNull().default(false),
		maxConsecutive: smallint(),
		minNoticeDays: smallint().notNull().default(0),
		halfDayAllowed: boolean().notNull().default(true),
		gender: text(),
		duringProbation: boolean().notNull().default(true),
		sandwich: boolean().notNull().default(false),
		active: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('leave_types', t),
		unique('leave_types_code_uq').on(t.tenantId, t.code),
		unique('leave_types_name_uq').on(t.tenantId, t.name),
		check('leave_types_code_ck', sql`${t.code} ~ '^[a-z][a-z_]{1,29}$'`),
		check('leave_types_name_ck', sql`length(trim(${t.name})) between 1 and 60`),
		check('leave_types_quota_ck', sql`${t.quota} is null or ${t.quota} between 0 and 366`),
		check('leave_types_carry_ck', sql`${t.carryCap} between 0 and 366`),
		check('leave_types_accrual_ck', sql`${t.accrual} in ('yearly','monthly','none')`),
		check('leave_types_consecutive_ck', sql`${t.maxConsecutive} is null or ${t.maxConsecutive} between 1 and 366`),
		check('leave_types_notice_ck', sql`${t.minNoticeDays} between 0 and 365`),
		check('leave_types_gender_ck', sql`${t.gender} is null or ${t.gender} in ('female','male')`)
	]
);

export const leaveLedger = pgTable(
	'leave_ledger',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		leaveTypeId: uuid().notNull(),
		fiscalYear: smallint().notNull(),
		kind: text().notNull(),
		days: numeric({ precision: 6, scale: 2, mode: 'number' }).notNull(),
		period: text(),
		refId: uuid(),
		expiresOn: date({ mode: 'string' }),
		note: text(),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('leave_ledger', t),
		tfk('leave_ledger_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('leave_ledger_type_fk', t, t.leaveTypeId, leaveTypes, 'restrict'),
		uniqueIndex('leave_ledger_period_uq')
			.on(t.tenantId, t.employeeId, t.leaveTypeId, t.fiscalYear, t.kind, t.period)
			.where(sql`${t.period} is not null`),
		index('leave_ledger_balance_ix').on(t.tenantId, t.employeeId, t.fiscalYear, t.leaveTypeId),
		check(
			'leave_ledger_kind_ck',
			sql`${t.kind} in ('accrual','taken','adjustment','carry','expiry','encash','comp_credit')`
		),
		check('leave_ledger_days_ck', sql`${t.days} <> 0 and abs(${t.days}) <= 366`),
		check('leave_ledger_note_ck', sql`${t.note} is null or length(${t.note}) <= 500`)
	]
);
