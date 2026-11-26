import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { citext, tfk, tenantBase, tenantKey, trigramIndex, tstz } from './_helpers';
import { memberships } from './core';
import { employees } from './org';

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TICKET_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'] as const;

export const ticketCategories = pgTable(
	'ticket_categories',
	{
		...tenantBase(),
		name: citext().notNull(),
		confidential: boolean().notNull().default(false),
		slaHours: integer().notNull(),
		active: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('ticket_categories', t),
		unique('ticket_categories_name_uq').on(t.tenantId, t.name),
		check('ticket_categories_name_ck', sql`length(trim(${t.name})) between 1 and 60`),
		check('ticket_categories_sla_ck', sql`${t.slaHours} between 1 and 720`)
	]
);

export const tickets = pgTable(
	'tickets',
	{
		...tenantBase(),
		number: integer().notNull(),
		categoryId: uuid().notNull(),
		requesterEmployeeId: uuid().notNull(),
		subject: text().notNull(),
		description: text().notNull(),
		priority: text().notNull().default('normal'),
		status: text().notNull().default('open'),
		assigneeMembershipId: uuid(),
		slaDueAt: tstz().notNull(),
		resolvedAt: tstz()
	},
	(t) => [
		tenantKey('tickets', t),
		unique('tickets_number_uq').on(t.tenantId, t.number),
		tfk('tickets_category_fk', t, t.categoryId, ticketCategories, 'restrict'),
		tfk('tickets_requester_fk', t, t.requesterEmployeeId, employees, 'cascade'),
		tfk('tickets_assignee_fk', t, t.assigneeMembershipId, memberships),
		index('tickets_status_idx').on(t.tenantId, t.status),
		index('tickets_requester_idx').on(t.tenantId, t.requesterEmployeeId),
		trigramIndex('tickets_search_idx', t, t.subject),
		check('tickets_number_ck', sql`${t.number} > 0`),
		check('tickets_subject_ck', sql`length(trim(${t.subject})) between 1 and 160`),
		check('tickets_description_ck', sql`length(trim(${t.description})) between 1 and 5000`),
		check('tickets_priority_ck', sql`${t.priority} in ('low','normal','high','urgent')`),
		check('tickets_status_ck', sql`${t.status} in ('open','in_progress','waiting','resolved','closed')`),
		check('tickets_resolved_ck', sql`(${t.status} in ('resolved','closed')) = (${t.resolvedAt} is not null)`)
	]
);

export const ticketComments = pgTable(
	'ticket_comments',
	{
		...tenantBase(),
		ticketId: uuid().notNull(),
		authorMembershipId: uuid(),
		body: text().notNull(),
		internal: boolean().notNull().default(false)
	},
	(t) => [
		tenantKey('ticket_comments', t),
		tfk('ticket_comments_ticket_fk', t, t.ticketId, tickets, 'cascade'),
		tfk('ticket_comments_author_fk', t, t.authorMembershipId, memberships),
		index('ticket_comments_ticket_idx').on(t.tenantId, t.ticketId),
		check('ticket_comments_body_ck', sql`length(trim(${t.body})) between 1 and 5000`)
	]
);
