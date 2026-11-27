import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { memberships } from './core';

export const apiKeys = pgTable(
	'api_keys',
	{
		...tenantBase(),
		name: text().notNull(),
		prefix: text().notNull(),
		keyHash: text().notNull(),
		grants: jsonb().$type<Record<string, string>>().notNull(),
		createdByMembershipId: uuid().notNull(),
		expiresAt: tstz().notNull(),
		lastUsedAt: tstz(),
		revokedAt: tstz()
	},
	(t) => [
		tenantKey('api_keys', t),
		tfk('api_keys_creator_fk', t, t.createdByMembershipId, memberships, 'cascade'),
		unique('api_keys_name_uq').on(t.tenantId, t.name),
		uniqueIndex('api_keys_hash_uq').on(t.keyHash),
		check('api_keys_name_ck', sql`length(trim(${t.name})) between 1 and 60`),
		check('api_keys_hash_ck', sql`${t.keyHash} ~ '^[0-9a-f]{64}$' and ${t.prefix} ~ '^[0-9a-f]{8}$'`),
		check('api_keys_grants_ck', sql`jsonb_typeof(${t.grants}) = 'object'`),
		check('api_keys_expiry_ck', sql`${t.expiresAt} <= ${t.createdAt} + interval '366 days'`)
	]
);
