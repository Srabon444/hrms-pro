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

export const workWeeks = pgTable(
	'work_weeks',
	{
		...tenantBase(),
		name: text().notNull(),
		weekendDays: smallint().array().notNull(),
		rosterMode: boolean().notNull().default(false),
		active: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('work_weeks', t),
		unique('work_weeks_name_uq').on(t.tenantId, t.name),
		check('work_weeks_name_ck', sql`length(trim(${t.name})) between 1 and 60`),
		check(
			'work_weeks_days_ck',
			sql`cardinality(${t.weekendDays}) <= 7 and ${t.weekendDays} <@ '{0,1,2,3,4,5,6}'::smallint[]`
		)
	]
);

export const workWeekAssignments = pgTable(
	'work_week_assignments',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		workWeekId: uuid().notNull(),
		effectiveFrom: date({ mode: 'string' }).notNull(),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('work_week_assignments', t),
		tfk('work_week_assignments_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('work_week_assignments_week_fk', t, t.workWeekId, workWeeks, 'restrict'),
		unique('work_week_assignments_from_uq').on(t.tenantId, t.employeeId, t.effectiveFrom)
	]
);

export const ROSTER_KINDS = ['work', 'off'] as const;

export const rosterEntries = pgTable(
	'roster_entries',
	{
		...tenantBase(),
		employeeId: uuid(),
		date: date({ mode: 'string' }).notNull(),
		shiftId: uuid(),
		kind: text().notNull().default('work'),
		status: text().notNull().default('draft'),
		note: text(),
		createdByUserId: uuid(),
		publishedAt: tstz()
	},
	(t) => [
		tenantKey('roster_entries', t),
		tfk('roster_entries_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('roster_entries_shift_fk', t, t.shiftId, shifts, 'restrict'),
		uniqueIndex('roster_entries_day_uq')
			.on(t.tenantId, t.employeeId, t.date)
			.where(sql`${t.employeeId} is not null`),
		index('roster_entries_date_idx').on(t.tenantId, t.date),
		check('roster_entries_kind_ck', sql`${t.kind} in ('work','off')`),
		check('roster_entries_status_ck', sql`${t.status} in ('draft','published')`),
		check('roster_entries_shift_ck', sql`(${t.kind} = 'work') = (${t.shiftId} is not null)`),
		check('roster_entries_note_ck', sql`${t.note} is null or length(${t.note}) <= 200`)
	]
);

export const CLAIM_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;

export const openShiftClaims = pgTable(
	'open_shift_claims',
	{
		...tenantBase(),
		rosterEntryId: uuid().notNull(),
		employeeId: uuid().notNull(),
		status: text().notNull().default('pending'),
		decidedByUserId: uuid(),
		decidedAt: tstz()
	},
	(t) => [
		tenantKey('open_shift_claims', t),
		tfk('open_shift_claims_entry_fk', t, t.rosterEntryId, rosterEntries, 'cascade'),
		tfk('open_shift_claims_employee_fk', t, t.employeeId, employees, 'restrict'),
		unique('open_shift_claims_uq').on(t.tenantId, t.rosterEntryId, t.employeeId),
		index('open_shift_claims_status_ix').on(t.tenantId, t.status),
		check('open_shift_claims_status_ck', sql`${t.status} in ('pending','approved','rejected','withdrawn')`)
	]
);

export const SWAP_STATUSES = ['asked', 'accepted', 'approved', 'declined', 'rejected', 'cancelled', 'expired'] as const;

export const shiftSwaps = pgTable(
	'shift_swaps',
	{
		...tenantBase(),
		requesterId: uuid().notNull(),
		requesterEntryId: uuid().notNull(),
		counterpartId: uuid().notNull(),
		counterpartEntryId: uuid(),
		status: text().notNull().default('asked'),
		note: text(),
		requesterApprovedByUserId: uuid(),
		counterpartApprovedByUserId: uuid(),
		decidedByUserId: uuid(),
		decidedAt: tstz()
	},
	(t) => [
		tenantKey('shift_swaps', t),
		tfk('shift_swaps_requester_fk', t, t.requesterId, employees, 'restrict'),
		tfk('shift_swaps_counterpart_fk', t, t.counterpartId, employees, 'restrict'),
		tfk('shift_swaps_requester_entry_fk', t, t.requesterEntryId, rosterEntries, 'cascade'),
		tfk('shift_swaps_counterpart_entry_fk', t, t.counterpartEntryId, rosterEntries, 'cascade'),
		index('shift_swaps_status_ix').on(t.tenantId, t.status),
		uniqueIndex('shift_swaps_requester_open_uq')
			.on(t.tenantId, t.requesterEntryId)
			.where(sql`${t.status} in ('asked','accepted')`),
		check(
			'shift_swaps_status_ck',
			sql`${t.status} in ('asked','accepted','approved','declined','rejected','cancelled','expired')`
		),
		check('shift_swaps_people_ck', sql`${t.requesterId} <> ${t.counterpartId}`),
		check('shift_swaps_note_ck', sql`${t.note} is null or length(${t.note}) <= 200`)
	]
);

export const availability = pgTable(
	'availability',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		weekday: smallint(),
		date: date({ mode: 'string' }),
		fromTime: time().notNull(),
		toTime: time().notNull(),
		note: text()
	},
	(t) => [
		tenantKey('availability', t),
		tfk('availability_employee_fk', t, t.employeeId, employees, 'restrict'),
		index('availability_employee_idx').on(t.tenantId, t.employeeId),
		check(
			'availability_when_ck',
			sql`(${t.weekday} is null) <> (${t.date} is null) and (${t.weekday} is null or ${t.weekday} between 0 and 6)`
		),
		check('availability_times_ck', sql`${t.fromTime} < ${t.toTime}`),
		check('availability_note_ck', sql`${t.note} is null or length(${t.note}) <= 200`)
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
		lateMinutes: smallint().notNull().default(0),
		timeZone: text()
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

export const ATTENDANCE_REQUEST_KINDS = ['regularization', 'wfh', 'overtime'] as const;

export const attendanceRequests = pgTable(
	'attendance_requests',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		kind: text().notNull(),
		date: date({ mode: 'string' }).notNull(),
		punchAt: tstz(),
		minutes: smallint(),
		approvedMinutes: smallint(),
		reason: text().notNull(),
		status: text().notNull().default('pending'),
		requestedByUserId: uuid().notNull(),
		decidedByUserId: uuid(),
		decidedAt: tstz(),
		decisionNote: text()
	},
	(t) => [
		tenantKey('attendance_requests', t),
		tfk('attendance_requests_employee_fk', t, t.employeeId, employees, 'restrict'),
		index('attendance_requests_employee_ix').on(t.tenantId, t.employeeId, t.date),
		index('attendance_requests_status_ix').on(t.tenantId, t.status),
		uniqueIndex('attendance_requests_day_uq')
			.on(t.tenantId, t.employeeId, t.kind, t.date)
			.where(sql`${t.kind} in ('wfh','overtime') and ${t.status} in ('pending','approved')`),
		uniqueIndex('attendance_requests_punch_uq')
			.on(t.tenantId, t.employeeId, t.punchAt)
			.where(sql`${t.kind} = 'regularization' and ${t.status} in ('pending','approved')`),
		check('attendance_requests_kind_ck', sql`${t.kind} in ('regularization','wfh','overtime')`),
		check('attendance_requests_status_ck', sql`${t.status} in ('pending','approved','rejected','cancelled')`),
		check(
			'attendance_requests_shape_ck',
			sql`(${t.kind} = 'regularization') = (${t.punchAt} is not null) and (${t.kind} = 'overtime') = (${t.minutes} is not null) and (${t.approvedMinutes} is null or ${t.kind} = 'overtime')`
		),
		check(
			'attendance_requests_minutes_ck',
			sql`(${t.minutes} is null or ${t.minutes} between 15 and 1440) and (${t.approvedMinutes} is null or ${t.approvedMinutes} between 15 and ${t.minutes})`
		),
		check(
			'attendance_requests_notes_ck',
			sql`length(trim(${t.reason})) between 1 and 500 and coalesce(length(${t.decisionNote}), 0) <= 500`
		)
	]
);
