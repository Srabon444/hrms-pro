import { gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditEvent } from '../audit';
import { encrypt } from '../auth/crypto';
import { now } from '../clock';
import { config } from '../config';
import { dateIn } from '../dates';
import {
	AI_FEATURES,
	AI_PROVIDERS,
	aiSettings,
	aiUsage,
	tenantSettings,
	type AiFeature,
	type AiProvider
} from '../db/schema';
import { AppError } from '../errors';
import { can, userCtx, type requireMember } from '../rbac/access';
import { withTenant, type Tx } from '../tenancy';
import { MODEL_ID } from './models';
import { AI_MESSAGES, guardNoTx, keyAad, listModels, openKey, testKey, testPlatform } from './service';
import { AiError } from './providers';

type Member = ReturnType<typeof requireMember>;

export const platformOpen = (m: Member) => {
	const c = config();
	return c.AI_PLATFORM_GEMINI && !!c.GEMINI_API_KEY && m.tenant.aiPlatform;
};

const aiFail = (err: unknown): never => {
	if (err instanceof AiError) throw new AppError(err.code, AI_MESSAGES[err.code], 400);
	throw err;
};

const ownKey = (keyEnc: string, tenantId: string): string => {
	try {
		return openKey(keyEnc, tenantId);
	} catch (err) {
		return aiFail(err);
	}
};

const NO_AI = { ask: false, ocr: false, write: false };

export async function aiFeaturesOn(tx: Tx, m: Member): Promise<Record<AiFeature, boolean>> {
	if (!can(m.access, 'ai.use')) return NO_AI;
	const [s] = await tx
		.select({
			enabled: aiSettings.enabled,
			features: aiSettings.features,
			ownKey: sql<boolean>`${aiSettings.keyEnc} is not null`
		})
		.from(aiSettings);
	if (!s?.enabled || !(s.ownKey || platformOpen(m))) return NO_AI;
	return { ask: !!s.features?.ask, ocr: !!s.features?.ocr, write: !!s.features?.write };
}

async function stored(m: Member) {
	return withTenant(userCtx(m), async (tx) => {
		const [s] = await tx.select().from(aiSettings);
		const [t] = await tx.select({ tz: tenantSettings.timezone }).from(tenantSettings);
		return { s, tz: t?.tz ?? 'UTC' };
	});
}

export async function aiView(m: Member) {
	guardNoTx();
	const { s, tz } = await stored(m);
	const start = `${dateIn(now(), tz).slice(0, 7)}-01`;
	const usage = await withTenant(userCtx(m), (tx) =>
		tx
			.select({
				feature: aiUsage.feature,
				calls: sql<number>`count(*)::int`,
				failed: sql<number>`(count(*) filter (where not ${aiUsage.ok}))::int`,
				tokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::int`
			})
			.from(aiUsage)
			.where(gte(aiUsage.createdAt, sql`(${start}::date::timestamp at time zone ${tz})`))
			.groupBy(aiUsage.feature)
			.orderBy(aiUsage.feature)
	);
	const provider = (s?.provider ?? 'gemini') as AiProvider;
	const models = s?.keyEnc
		? await (async (enc: string) => listModels(provider, ownKey(enc, m.tenant.id)))(s.keyEnc).catch(
				() => [] as string[]
			)
		: [];
	const platform = platformOpen(m);
	return {
		settings: {
			enabled: s?.enabled ?? false,
			provider,
			model: s?.model ?? null,
			keyHint: s?.keyHint ?? null,
			keySetAt: s?.keySetAt ?? null,
			monthlyTokenBudget: s?.monthlyTokenBudget ?? 2_000_000,
			features: s?.features ?? { ask: true, ocr: true, write: true },
			sendPayroll: s?.sendPayroll ?? false
		},
		models,
		platform,
		platformBudget: config().AI_PLATFORM_MONTHLY_TOKENS,
		usage
	};
}

const on = z
	.string()
	.optional()
	.transform((v) => v === 'on');

export const aiSettingsSchema = z.object({
	enabled: on,
	consent: on,
	provider: z.enum(AI_PROVIDERS),
	model: z
		.string()
		.trim()
		.transform((v) => v || null)
		.pipe(z.string().regex(MODEL_ID).nullable()),
	apiKey: z
		.string()
		.trim()
		.max(400)
		.regex(/^([\x21-\x7e]{8,})?$/)
		.transform((v) => v || null),
	budget: z
		.string()
		.trim()
		.regex(/^\d{1,10}$/)
		.transform(Number)
		.pipe(z.number().int().min(0).max(1_000_000_000)),
	features: z.array(z.enum(AI_FEATURES)),
	sendPayroll: on
});

const formValues = (form: FormData) => ({
	enabled: form.get('enabled') ?? undefined,
	consent: form.get('consent') ?? undefined,
	provider: form.get('provider'),
	model: form.get('model') ?? '',
	apiKey: form.get('apiKey') ?? '',
	budget: form.get('budget'),
	features: form.getAll('features'),
	sendPayroll: form.get('sendPayroll') ?? undefined
});

const hintOf = (key: string) => `…${key.slice(-4)}`;

export async function saveAi(m: Member, form: FormData): Promise<void> {
	guardNoTx();
	const parsed = aiSettingsSchema.safeParse(formValues(form));
	if (!parsed.success) throw new AppError('invalid', 'Check the AI settings and try again.');
	const v = parsed.data;
	const { s } = await stored(m);
	if (v.enabled && !s?.enabled && !v.consent)
		throw new AppError('consent', 'Confirm that company data may be sent to the AI provider.');
	const keepKey = !v.apiKey && !!s?.keyEnc && s.provider === v.provider;
	if (!v.apiKey && s?.keyEnc && s.provider !== v.provider)
		throw new AppError('provider_key', 'Paste an API key for the new provider.');
	if (!v.apiKey && !keepKey && v.provider !== 'gemini')
		throw new AppError('provider_key', 'Paste an API key for this provider.');
	const key = v.apiKey ?? (keepKey && s?.keyEnc ? ownKey(s.keyEnc, m.tenant.id) : null);
	const models = v.apiKey ? (await testKey(m, v.provider, v.apiKey).catch(aiFail)).models : null;
	if (v.model && !(keepKey && v.model === s?.model)) {
		if (!key) throw new AppError('model', 'A model can only be chosen with your own API key.');
		const list = models ?? (await listModels(v.provider, key).catch(aiFail));
		if (!list.includes(v.model)) throw new AppError('model', 'Pick a model from the list.');
	}
	const features = Object.fromEntries(AI_FEATURES.map((f) => [f, v.features.includes(f)])) as Record<
		AiFeature,
		boolean
	>;
	const keyCols = v.apiKey
		? { keyEnc: encrypt(v.apiKey, undefined, keyAad(m.tenant.id)), keyHint: hintOf(v.apiKey), keySetAt: now() }
		: keepKey
			? {}
			: { keyEnc: null, keyHint: null, keySetAt: null };
	const values = {
		enabled: v.enabled,
		provider: v.provider,
		model: v.model,
		monthlyTokenBudget: v.budget,
		features,
		sendPayroll: v.sendPayroll,
		...keyCols
	};
	const ctx = userCtx(m);
	await withTenant(ctx, async (tx) => {
		const [row] = await tx
			.insert(aiSettings)
			.values({ tenantId: m.tenant.id, ...values })
			.onConflictDoUpdate({ target: aiSettings.tenantId, set: values })
			.returning({ id: aiSettings.id });
		if (v.apiKey)
			await auditEvent(tx, ctx, 'ai_settings', row.id, 'ai.key_set', { provider: v.provider, hint: hintOf(v.apiKey) });
		await auditEvent(tx, ctx, 'ai_settings', row.id, 'ai.settings_changed', {
			enabled: String(v.enabled),
			provider: v.provider,
			model: v.model ?? '',
			budget: String(v.budget)
		});
	});
}

export async function removeAiKey(m: Member): Promise<void> {
	const ctx = userCtx(m);
	await withTenant(ctx, async (tx) => {
		const [row] = await tx
			.update(aiSettings)
			.set({ keyEnc: null, keyHint: null, keySetAt: null, model: null })
			.where(sql`${aiSettings.keyEnc} is not null`)
			.returning({ id: aiSettings.id });
		if (row) await auditEvent(tx, ctx, 'ai_settings', row.id, 'ai.key_removed');
	});
}

export async function testAi(m: Member): Promise<{ model: string; platform: boolean }> {
	guardNoTx();
	const { s } = await stored(m);
	if (s?.keyEnc) {
		const r = await testKey(m, s.provider as AiProvider, ownKey(s.keyEnc, m.tenant.id)).catch(aiFail);
		return { model: r.model, platform: false };
	}
	return { model: await testPlatform(m).catch(aiFail), platform: true };
}
