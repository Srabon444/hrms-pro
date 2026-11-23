import { sql } from 'drizzle-orm';
import { boolean, check, numeric, pgTable, smallint, text, unique } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey } from './_helpers';

export const LEAVE_ACCRUALS = ['yearly', 'monthly', 'none'] as const;
export const LEAVE_GENDERS = ['female', 'male'] as const;

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
