import { sql } from 'drizzle-orm';
import { check, date, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk } from './_helpers';
import { memberships } from './core';

export type ShareSpec = {
	filters: { from: string; to: string; department: string };
	sections: string[];
	columns: string[];
	employees: string[];
};

export const reportShares = pgTable(
	'report_shares',
	{
		...tenantBase(),
		reportId: text().notNull(),
		title: text().notNull(),
		period: text().notNull(),
		spec: jsonb().$type<ShareSpec>().notNull(),
		storageKey: text().notNull(),
		recipientMembershipIds: uuid().array().notNull(),
		sharedByMembershipId: uuid().notNull(),
		sharedByUserId: uuid(),
		expiresOn: date({ mode: 'string' }).notNull()
	},
	(t) => [
		tenantKey('report_shares', t),
		tfk('report_shares_sharer_fk', t, t.sharedByMembershipId, memberships, 'restrict'),
		check('report_shares_recipients_ck', sql`cardinality(${t.recipientMembershipIds}) between 1 and 200`),
		index('report_shares_created_idx').on(t.tenantId, t.createdAt)
	]
);
