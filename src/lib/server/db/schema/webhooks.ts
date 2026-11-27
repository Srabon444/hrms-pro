import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, tenantBase, tenantId, tenantKey, tfk, tstz } from './_helpers';
import { memberships } from './core';

export const WEBHOOK_EVENTS = [
	'employee.created',
	'employee.updated',
	'leave_request.created',
	'leave_request.updated'
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const webhookEndpoints = pgTable(
	'webhook_endpoints',
	{
		...tenantBase(),
		url: text().notNull(),
		secretEnc: text().notNull(),
		events: text().array().$type<WebhookEvent[]>().notNull(),
		active: boolean().notNull().default(true),
		failureCount: integer().notNull().default(0),
		disabledAt: tstz(),
		createdByMembershipId: uuid().notNull()
	},
	(t) => [
		tenantKey('webhook_endpoints', t),
		tfk('webhook_endpoints_creator_fk', t, t.createdByMembershipId, memberships, 'cascade'),
		check('webhook_endpoints_url_ck', sql`${t.url} ~ '^https://' and length(${t.url}) <= 500`),
		check(
			'webhook_endpoints_events_ck',
			sql`cardinality(${t.events}) between 1 and 4 and ${t.events} <@ array['employee.created','employee.updated','leave_request.created','leave_request.updated']::text[]`
		),
		check('webhook_endpoints_failures_ck', sql`${t.failureCount} >= 0`)
	]
);

export const webhookDeliveries = pgTable(
	'webhook_deliveries',
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: tenantId(),
		endpointId: uuid().notNull(),
		event: text().$type<WebhookEvent>().notNull(),
		data: jsonb().$type<Record<string, string>>().notNull(),
		status: text().$type<'pending' | 'delivered' | 'failed'>().notNull().default('pending'),
		attempts: integer().notNull().default(0),
		nextAttemptAt: tstz().notNull().defaultNow(),
		lastStatus: integer(),
		lastError: text(),
		deliveredAt: tstz(),
		createdAt: createdAt()
	},
	(t) => [
		tfk('webhook_deliveries_endpoint_fk', t, t.endpointId, webhookEndpoints, 'cascade'),
		index('webhook_deliveries_due_idx')
			.on(t.tenantId, t.nextAttemptAt)
			.where(sql`${t.status} = 'pending'`),
		index('webhook_deliveries_endpoint_idx').on(t.tenantId, t.endpointId, t.createdAt),
		index('webhook_deliveries_created_idx').on(t.tenantId, t.createdAt),
		check('webhook_deliveries_status_ck', sql`${t.status} in ('pending','delivered','failed')`),
		check('webhook_deliveries_attempts_ck', sql`${t.attempts} between 0 and 8`)
	]
);
