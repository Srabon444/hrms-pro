import { sql } from 'drizzle-orm';
import { check, customType, index, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { policies } from './policies';
import { candidates } from './recruitment';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const FILE_TEXT_STATUSES = ['ok', 'failed'] as const;
export const FILE_TEXT_MAX_CHARS = 200_000;
export const FILE_TEXT_FINAL_ERRORS = ['unsupported', 'too_large', 'too_complex'];

export const fileTexts = pgTable(
	'file_texts',
	{
		...tenantBase(),
		policyId: uuid(),
		candidateId: uuid(),
		sha256: text().notNull(),
		status: text().notNull(),
		text: text().notNull().default(''),
		tsv: tsvector().generatedAlwaysAs(sql`to_tsvector('simple', text)`),
		attempts: smallint().notNull().default(0),
		lastError: text(),
		nextRetryAt: tstz(),
		model: text(),
		extractedAt: tstz()
	},
	(t) => [
		tenantKey('file_texts', t),
		tfk('file_texts_policy_fk', t, t.policyId, policies, 'cascade'),
		tfk('file_texts_candidate_fk', t, t.candidateId, candidates, 'cascade'),
		uniqueIndex('file_texts_policy_uq')
			.on(t.tenantId, t.policyId)
			.where(sql`${t.policyId} is not null`),
		uniqueIndex('file_texts_candidate_uq')
			.on(t.tenantId, t.candidateId)
			.where(sql`${t.candidateId} is not null`),
		index('file_texts_tsv_idx').using('gin', t.tsv),
		check('file_texts_source_ck', sql`num_nonnulls(${t.policyId}, ${t.candidateId}) = 1`),
		check('file_texts_status_ck', sql`${t.status} in ('ok','failed')`),
		check('file_texts_text_ck', sql`length(${t.text}) <= 200000`),
		check('file_texts_attempts_ck', sql`${t.attempts} >= 0`)
	]
);
