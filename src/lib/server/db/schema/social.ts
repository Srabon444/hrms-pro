import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantId, tenantKey, tfk, tstz } from './_helpers';
import { announcements } from './announcements';
import { memberships } from './core';

export const REACTION_KINDS = ['like', 'love', 'celebrate', 'insightful', 'funny', 'support'] as const;

export const kudos = pgTable(
	'kudos',
	{
		...tenantBase(),
		fromMembershipId: uuid(),
		message: text().notNull(),
		valueTag: text(),
		hiddenByUserId: uuid(),
		hiddenAt: tstz()
	},
	(t) => [
		tenantKey('kudos', t),
		tfk('kudos_from_fk', t, t.fromMembershipId, memberships, 'cascade'),
		index('kudos_created_idx').on(t.tenantId, t.createdAt),
		check('kudos_message_ck', sql`length(${t.message}) between 1 and 500`),
		check('kudos_value_ck', sql`${t.valueTag} is null or length(${t.valueTag}) between 1 and 40`)
	]
);

export const kudosRecipients = pgTable(
	'kudos_recipients',
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: tenantId(),
		kudosId: uuid().notNull(),
		membershipId: uuid().notNull()
	},
	(t) => [
		tenantKey('kudos_recipients', t),
		tfk('kudos_recipients_kudos_fk', t, t.kudosId, kudos, 'cascade'),
		tfk('kudos_recipients_membership_fk', t, t.membershipId, memberships, 'cascade'),
		uniqueIndex('kudos_recipients_uq').on(t.tenantId, t.kudosId, t.membershipId),
		index('kudos_recipients_member_idx').on(t.tenantId, t.membershipId)
	]
);

export const announcementReactions = pgTable(
	'announcement_reactions',
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: tenantId(),
		announcementId: uuid().notNull(),
		membershipId: uuid().notNull(),
		kind: text().$type<(typeof REACTION_KINDS)[number]>().notNull()
	},
	(t) => [
		tenantKey('announcement_reactions', t),
		tfk('announcement_reactions_announcement_fk', t, t.announcementId, announcements, 'cascade'),
		tfk('announcement_reactions_membership_fk', t, t.membershipId, memberships, 'cascade'),
		uniqueIndex('announcement_reactions_uq').on(t.tenantId, t.announcementId, t.membershipId, t.kind),
		index('announcement_reactions_member_idx').on(t.tenantId, t.membershipId),
		check(
			'announcement_reactions_kind_ck',
			sql`${t.kind} in ('like', 'love', 'celebrate', 'insightful', 'funny', 'support')`
		)
	]
);

export const announcementComments = pgTable(
	'announcement_comments',
	{
		...tenantBase(),
		announcementId: uuid().notNull(),
		authorMembershipId: uuid(),
		body: text().notNull(),
		mentions: uuid()
			.array()
			.notNull()
			.default(sql`'{}'::uuid[]`),
		hiddenByUserId: uuid(),
		hiddenAt: tstz()
	},
	(t) => [
		tenantKey('announcement_comments', t),
		tfk('announcement_comments_announcement_fk', t, t.announcementId, announcements, 'cascade'),
		tfk('announcement_comments_author_fk', t, t.authorMembershipId, memberships, 'cascade'),
		index('announcement_comments_thread_idx').on(t.tenantId, t.announcementId, t.createdAt),
		index('announcement_comments_author_idx').on(t.tenantId, t.authorMembershipId),
		check('announcement_comments_body_ck', sql`length(${t.body}) between 1 and 2000`),
		check('announcement_comments_mentions_ck', sql`cardinality(${t.mentions}) <= 10`)
	]
);
