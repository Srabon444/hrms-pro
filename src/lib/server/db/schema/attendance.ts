import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	pgTable,
	smallint,
	text,
	time,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { employees } from './org';

export const PUNCH_SOURCES = ['web', 'manual', 'device', 'regularization'] as const;

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

export const attendancePunches = pgTable(
	'attendance_punches',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		at: tstz().notNull(),
		source: text().notNull(),
		ip: text(),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('attendance_punches', t),
		tfk('attendance_punches_employee_fk', t, t.employeeId, employees, 'restrict'),
		unique('attendance_punches_at_uq').on(t.tenantId, t.employeeId, t.at),
		check('attendance_punches_source_ck', sql`${t.source} in ('web','manual','device','regularization')`),
		check('attendance_punches_ip_ck', sql`${t.ip} is null or length(${t.ip}) <= 64`)
	]
);

export const attendanceDays = pgTable(
	'attendance_days',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		date: date({ mode: 'string' }).notNull(),
		shiftId: uuid(),
		status: text().notNull(),
		firstIn: tstz(),
		lastOut: tstz(),
		workedMinutes: smallint().notNull().default(0),
		lateMinutes: smallint().notNull().default(0)
	},
	(t) => [
		tenantKey('attendance_days', t),
		tfk('attendance_days_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('attendance_days_shift_fk', t, t.shiftId, shifts, 'restrict'),
		unique('attendance_days_day_uq').on(t.tenantId, t.employeeId, t.date),
		index('attendance_days_date_idx').on(t.tenantId, t.date),
		check(
			'attendance_days_status_ck',
			sql`${t.status} in ('present','late','half_day','absent','on_leave','holiday','weekend','wfh')`
		),
		check(
			'attendance_days_minutes_ck',
			sql`${t.workedMinutes} between 0 and 1440 and ${t.lateMinutes} between 0 and 1440`
		)
	]
);
