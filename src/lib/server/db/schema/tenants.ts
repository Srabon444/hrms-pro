import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const ts = () => timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const tenants = pgTable(
	'tenants',
	{
		id: uuid().primaryKey().defaultRandom(),
		slug: text().notNull().unique(),
		name: text().notNull(),
		status: text().notNull().default('active'),
		createdAt: ts(),
		updatedAt: ts().$onUpdate(() => new Date())
	},
	(t) => [
		check('tenants_status_ck', sql`${t.status} in ('active','suspended')`),
		check('tenants_slug_ck', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,40}$'`)
	]
);
