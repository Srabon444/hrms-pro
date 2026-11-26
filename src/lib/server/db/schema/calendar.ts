import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, text, time, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { memberships } from './core';
import { branches, departments } from './org';

export const calendarFeeds = pgTable(
	'calendar_feeds',
	{
		...tenantBase(),
		membershipId: uuid().notNull(),
		tokenHash: text().notNull(),
		tokenPrefix: text().notNull(),
		lastUsedAt: tstz(),
		revokedAt: tstz()
	},
	(t) => [
		tenantKey('calendar_feeds', t),
		tfk('calendar_feeds_membership_fk', t, t.membershipId, memberships, 'cascade'),
		uniqueIndex('calendar_feeds_token_uq').on(t.tokenHash),
		uniqueIndex('calendar_feeds_active_uq')
			.on(t.tenantId, t.membershipId)
			.where(sql`${t.revokedAt} is null`),
		check('calendar_feeds_hash_ck', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`)
	]
);

export const memberSecrets = pgTable(
	'member_secrets',
	{
		...tenantBase(),
		membershipId: uuid().notNull(),
		pdfPasswordEnc: text().notNull()
	},
	(t) => [
		tenantKey('member_secrets', t),
		tfk('member_secrets_membership_fk', t, t.membershipId, memberships, 'cascade'),
		uniqueIndex('member_secrets_membership_uq').on(t.tenantId, t.membershipId)
	]
);

export const EVENT_AUDIENCES = ['all', 'department', 'branch'] as const;
export const RSVP_RESPONSES = ['yes', 'no', 'maybe'] as const;

export const events = pgTable(
	'events',
	{
		...tenantBase(),
		title: text().notNull(),
		description: text().notNull().default(''),
		location: text().notNull().default(''),
		startDate: date({ mode: 'string' }).notNull(),
		endDate: date({ mode: 'string' }).notNull(),
		startTime: time(),
		endTime: time(),
		audience: text().notNull().default('all'),
		departmentId: uuid(),
		branchId: uuid(),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('events', t),
		tfk('events_department_fk', t, t.departmentId, departments, 'cascade'),
		tfk('events_branch_fk', t, t.branchId, branches, 'cascade'),
		index('events_dates_idx').on(t.tenantId, t.startDate, t.endDate),
		check('events_title_ck', sql`length(trim(${t.title})) between 1 and 160`),
		check('events_description_ck', sql`length(${t.description}) <= 2000`),
		check('events_location_ck', sql`length(${t.location}) <= 200`),
		check('events_span_ck', sql`${t.endDate} >= ${t.startDate} and ${t.endDate} - ${t.startDate} <= 31`),
		check(
			'events_times_ck',
			sql`(${t.startTime} is null and ${t.endTime} is null) or (${t.startTime} is not null and ${t.endTime} is not null and (${t.endDate} > ${t.startDate} or ${t.endTime} > ${t.startTime}))`
		),
		check(
			'events_audience_ck',
			sql`(${t.audience} = 'all' and ${t.departmentId} is null and ${t.branchId} is null) or (${t.audience} = 'department' and ${t.departmentId} is not null and ${t.branchId} is null) or (${t.audience} = 'branch' and ${t.branchId} is not null and ${t.departmentId} is null)`
		)
	]
);

export const eventRsvps = pgTable(
	'event_rsvps',
	{
		...tenantBase(),
		eventId: uuid().notNull(),
		membershipId: uuid().notNull(),
		response: text().notNull()
	},
	(t) => [
		tenantKey('event_rsvps', t),
		tfk('event_rsvps_event_fk', t, t.eventId, events, 'cascade'),
		tfk('event_rsvps_membership_fk', t, t.membershipId, memberships, 'cascade'),
		uniqueIndex('event_rsvps_member_uq').on(t.tenantId, t.eventId, t.membershipId),
		check('event_rsvps_response_ck', sql`${t.response} in ('yes','no','maybe')`)
	]
);
