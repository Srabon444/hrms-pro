import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { memberships } from './core';

export const AI_PROVIDERS = ['gemini', 'openai', 'anthropic'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const AI_FEATURES = ['ask', 'ocr', 'write'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
export const AI_USAGE_FEATURES = [...AI_FEATURES, 'test', 'index'] as const;

export const aiSettings = pgTable(
	'ai_settings',
	{
		...tenantBase(),
		enabled: boolean().notNull().default(false),
		provider: text().notNull().default('gemini'),
		model: text(),
		keyEnc: text(),
		keyHint: text(),
		keySetAt: tstz(),
		monthlyTokenBudget: integer().notNull().default(2_000_000),
		features: jsonb().$type<Record<AiFeature, boolean>>().notNull().default({ ask: true, ocr: true, write: true }),
		sendPayroll: boolean().notNull().default(false)
	},
	(t) => [
		tenantKey('ai_settings', t),
		uniqueIndex('ai_settings_tenant_uq').on(t.tenantId),
		check('ai_settings_provider_ck', sql`${t.provider} in ('gemini','openai','anthropic')`),
		check('ai_settings_model_ck', sql`${t.model} is null or ${t.model} ~ '^[A-Za-z0-9._-]{1,80}$'`),
		check('ai_settings_budget_ck', sql`${t.monthlyTokenBudget} between 0 and 1000000000`),
		check('ai_settings_key_ck', sql`(${t.keyEnc} is null) = (${t.keyHint} is null)`)
	]
);

export const aiUsage = pgTable(
	'ai_usage',
	{
		...tenantBase(),
		membershipId: uuid(),
		feature: text().notNull(),
		provider: text().notNull(),
		model: text(),
		inputTokens: integer().notNull().default(0),
		outputTokens: integer().notNull().default(0),
		ok: boolean().notNull(),
		errorCode: text()
	},
	(t) => [
		tenantKey('ai_usage', t),
		tfk('ai_usage_membership_fk', t, t.membershipId, memberships, 'cascade'),
		index('ai_usage_created_idx').on(t.tenantId, t.createdAt),
		check('ai_usage_feature_ck', sql`${t.feature} in ('ask','ocr','write','test','index')`),
		check('ai_usage_tokens_ck', sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0`)
	]
);
