import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { citext, tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { users } from './core';

export const SSO_PROVIDERS = ['google', 'entra'] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

export const ssoConnections = pgTable(
	'sso_connections',
	{
		...tenantBase(),
		provider: text().$type<SsoProvider>().notNull(),
		clientId: text().notNull(),
		clientSecretEnc: text().notNull(),
		entraTenantId: text(),
		verifyToken: text().notNull(),
		active: boolean().notNull().default(true),
		enforce: boolean().notNull().default(false)
	},
	(t) => [
		tenantKey('sso_connections', t),
		uniqueIndex('sso_connections_tenant_uq').on(t.tenantId),
		check('sso_connections_provider_ck', sql`${t.provider} in ('google','entra')`),
		check('sso_connections_client_ck', sql`length(${t.clientId}) between 1 and 200`),
		check(
			'sso_connections_entra_ck',
			sql`(${t.provider} = 'entra') = (${t.entraTenantId} is not null) and (${t.entraTenantId} is null or ${t.entraTenantId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')`
		)
	]
);

export const ssoDomains = pgTable(
	'sso_domains',
	{
		...tenantBase(),
		connectionId: uuid().notNull(),
		domain: citext().notNull(),
		verifiedAt: tstz()
	},
	(t) => [
		tenantKey('sso_domains', t),
		tfk('sso_domains_connection_fk', t, t.connectionId, ssoConnections, 'cascade'),
		uniqueIndex('sso_domains_tenant_domain_uq').on(t.tenantId, t.domain),
		uniqueIndex('sso_domains_verified_uq')
			.on(t.domain)
			.where(sql`${t.verifiedAt} is not null`),
		check('sso_domains_domain_ck', sql`${t.domain} ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'`)
	]
);

export const userIdentities = pgTable(
	'user_identities',
	{
		...tenantBase(),
		connectionId: uuid().notNull(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		issuer: text().notNull(),
		subject: text().notNull(),
		email: citext().notNull()
	},
	(t) => [
		tenantKey('user_identities', t),
		tfk('user_identities_connection_fk', t, t.connectionId, ssoConnections, 'cascade'),
		uniqueIndex('user_identities_subject_uq').on(t.connectionId, t.issuer, t.subject),
		uniqueIndex('user_identities_user_uq').on(t.connectionId, t.userId),
		index('user_identities_user_idx').on(t.userId)
	]
);
