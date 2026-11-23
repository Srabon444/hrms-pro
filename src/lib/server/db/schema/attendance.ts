import { sql } from 'drizzle-orm';
import { boolean, check, date, smallint, text, time, pgTable, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk } from './_helpers';
import { employees } from './org';

export const shifts = pgTable(
	'shifts',
	{
		...tenantBase(),
		name: text().notNull(),
		startTime: time().notNull(),
		endTime: time().notNull(),
		graceMinutes: smallint().notNull().default(15),
		halfDayMinutes: smallint().notNull().default(240),
		fullDayMinutes: smallint().notNull().default(480),
		isDefault: boolean().notNull().default(false),
		active: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('shifts', t),
		unique('shifts_name_uq').on(t.tenantId, t.name),
		uniqueIndex('shifts_default_uq')
			.on(t.tenantId)
			.where(sql`${t.isDefault}`),
		check('shifts_name_ck', sql`length(trim(${t.name})) between 1 and 60`),
		check('shifts_times_ck', sql`${t.startTime} <> ${t.endTime}`),
		check('shifts_grace_ck', sql`${t.graceMinutes} between 0 and 240`),
		check(
			'shifts_minutes_ck',
			sql`${t.halfDayMinutes} between 1 and ${t.fullDayMinutes} and ${t.fullDayMinutes} <= 1440`
		),
		check('shifts_default_active_ck', sql`not ${t.isDefault} or ${t.active}`)
	]
);

export const shiftAssignments = pgTable(
	'shift_assignments',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		shiftId: uuid().notNull(),
		effectiveFrom: date({ mode: 'string' }).notNull(),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('shift_assignments', t),
		tfk('shift_assignments_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('shift_assignments_shift_fk', t, t.shiftId, shifts, 'restrict'),
		unique('shift_assignments_from_uq').on(t.tenantId, t.employeeId, t.effectiveFrom)
	]
);
