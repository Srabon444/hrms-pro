import { eq, gte, lt, sql } from 'drizzle-orm';
import { decrypt } from '../auth/crypto';
import { now } from '../clock';
import { config } from '../config';
import { dateIn } from '../dates';
import { authPool } from '../db';
import { aiSettings, aiUsage, tenantSettings, tenants, type AiFeature, type AiProvider } from '../db/schema';
import { log } from '../log';
import { hit } from '../ratelimit';
import { can, userCtx, type requireMember } from '../rbac/access';
import { redisReady, rkey } from '../redis';
import { insideTenantTx, systemCtx, withTenant, type TenantCtx } from '../tenancy';
import { fakeLister, fakeTransport } from './fake';
import { chainFor, httpLister, httpTransport, keyPrint, runChain, type Lister, type Transport } from './models';
import { AiError, type AiRequest, type AiResult } from './providers';

type Member = ReturnType<typeof requireMember>;
type UsageFeature = AiFeature | 'test' | 'index';
type Who = { tenantId: string; aiPlatform: boolean; ctx: TenantCtx; membershipId: string | null };
const whoOf = (m: Member): Who => ({
	tenantId: m.tenant.id,
	aiPlatform: m.tenant.aiPlatform,
	ctx: userCtx(m),
	membershipId: m.access.membershipId
});

export const AI_MESSAGES: Record<AiError['code'], string> = {
	key_invalid: 'The provider did not accept this API key.',
	quota: 'The API key has no quota or credit left with the provider.',
	rate_limited: 'The AI provider is busy. Try again in a minute.',
	unavailable: 'AI is unavailable right now. Try again shortly.',
	timeout: 'The AI provider took too long to answer. Try again.',
	blocked: 'The AI provider declined to answer this.',
	bad_output: 'The AI answer could not be read. Try again.',
	model_unsupported: 'None of the models can do this with this key.',
	budget: 'This month’s AI budget is used up.',
	disabled: 'AI is turned off for this.',
	no_key: 'AI has no API key set up yet.',
	file_too_large: 'This file is too large for the AI provider.'
};

export const transportFor = (p: AiProvider): Transport => (config().AI_FAKE ? fakeTransport : httpTransport(p));
export const listerFor = (p: AiProvider): Lister => (config().AI_FAKE ? fakeLister(p) : httpLister(p));

const MODELS_TTL_MS = 6 * 3600_000;
const MONTH_TTL_MS = 40 * 86_400_000;
const DAY_TTL_MS = 2 * 86_400_000;
const FILE_TOKENS = 1500;
const ANTHROPIC_IMAGE_MAX = 5 * 1024 * 1024;

export function guardNoTx(): void {
	if (insideTenantTx()) throw new Error('AI call inside a database transaction');
}

const redisOrClosed = () => redisReady().catch(() => Promise.reject(new AiError('unavailable')));

export async function listModels(provider: AiProvider, key: string, fresh = false): Promise<string[]> {
	const r = await redisOrClosed();
	const cacheKey = rkey('ai', 'models', provider, keyPrint(key));
	const cached = fresh ? null : await r.get(cacheKey);
	if (cached) return JSON.parse(cached) as string[];
	const ids = await listerFor(provider)(key, AbortSignal.timeout(config().AI_CALL_TIMEOUT_MS));
	await r.set(cacheKey, JSON.stringify(ids), 'PX', MODELS_TTL_MS);
	return ids;
}

const listedOrNull = (provider: AiProvider, key: string) =>
	listModels(provider, key).catch((err: unknown) => {
		if (err instanceof AiError && err.scope === 'key') throw err;
		return null;
	});

async function liveChain(provider: AiProvider, key: string, pinned: string | null): Promise<string[]> {
	const chain = chainFor(provider, pinned, await listedOrNull(provider, key));
	const r = await redisOrClosed();
	const cooled = await r.mget(chain.map((m) => rkey('ai', 'cool', keyPrint(key), m)));
	const open = chain.filter((_, i) => !cooled[i]);
	if (!open.length) throw new AiError('rate_limited');
	return open;
}

const cooling = (key: string) => ({
	cool: async (model: string, ms: number) => {
		await (await redisOrClosed()).set(rkey('ai', 'cool', keyPrint(key), model), '1', 'PX', Math.min(ms, 600_000));
	}
});

export function estimateTokens(req: AiRequest): number {
	const text = req.system.length + req.parts.reduce((n, p) => n + ('text' in p ? p.text.length : 0), 0);
	const files = req.parts.filter((p) => 'data' in p).length;
	return Math.ceil(text / 4) + files * FILE_TOKENS + req.maxOutputTokens;
}

const RESERVE = `
local used = redis.call('GET', KEYS[1])
if not used then return -1 end
local est = tonumber(ARGV[1])
if tonumber(used) + est > tonumber(ARGV[2]) then return 0 end
local ceiling = tonumber(ARGV[4])
if ceiling > 0 then
	local day = tonumber(redis.call('GET', KEYS[2]) or '0')
	if day + est > ceiling then return -2 end
	redis.call('INCRBY', KEYS[2], est)
	redis.call('PEXPIRE', KEYS[2], ARGV[5])
end
redis.call('INCRBY', KEYS[1], est)
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

type Plan = {
	tenantId: string;
	tz: string;
	provider: AiProvider;
	key: string;
	pinned: string | null;
	budget: number;
	platform: boolean;
};

const monthKey = (p: Plan) => rkey('t', p.tenantId, 'ai', 'tok', dateIn(now(), p.tz).slice(0, 7).replace('-', ''));
const dayKey = () => rkey('ai', 'platform', 'tok', now().toISOString().slice(0, 10).replaceAll('-', ''));

async function monthUsed(who: Who, tz: string): Promise<number> {
	const start = `${dateIn(now(), tz).slice(0, 7)}-01`;
	const [row] = await withTenant(who.ctx, (tx) =>
		tx
			.select({ used: sql<string>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)` })
			.from(aiUsage)
			.where(gte(aiUsage.createdAt, sql`(${start}::date::timestamp at time zone ${tz})`))
	);
	return Number(row?.used ?? 0);
}

async function reserve(who: Who, p: Plan, estimate: number): Promise<void> {
	const r = await redisOrClosed();
	const keys = [monthKey(p), dayKey()];
	const ceiling = p.platform ? config().AI_PLATFORM_DAILY_TOKENS : 0;
	const run = () =>
		r.eval(RESERVE, 2, ...keys, estimate, p.budget, MONTH_TTL_MS, ceiling, DAY_TTL_MS) as Promise<number>;
	let res = await run();
	if (res === -1) {
		await r.set(keys[0], String(await monthUsed(who, p.tz)), 'PX', MONTH_TTL_MS, 'NX');
		res = await run();
	}
	if (res === 1) return;
	throw new AiError(res === -2 ? 'unavailable' : 'budget');
}

const SETTLE = `
for i, k in ipairs(KEYS) do
	if redis.call('EXISTS', k) == 1 then redis.call('INCRBY', k, ARGV[1]) end
end
return 1
`;

async function settle(p: Plan, delta: number): Promise<void> {
	if (!delta) return;
	const r = await redisReady().catch(() => null);
	if (!r) return;
	const keys = p.platform ? [monthKey(p), dayKey()] : [monthKey(p)];
	await r.eval(SETTLE, keys.length, ...keys, delta).catch(() => undefined);
}

async function limits(m: Member, feature: UsageFeature): Promise<void> {
	const c = config();
	const results = await Promise.all([
		hit('ai', m.access.membershipId, c.RL_AI_PER_USER_MIN, 60_000),
		hit('ai_day', m.access.membershipId, c.RL_AI_PER_USER_DAY, 86_400_000),
		hit('ai_tenant', m.tenant.id, c.RL_AI_PER_TENANT_MIN, 60_000),
		...(feature === 'ocr' ? [hit('ai_ocr', m.access.membershipId, c.RL_AI_OCR_PER_USER_MIN, 60_000)] : [])
	]).catch(() => {
		throw new AiError('unavailable');
	});
	if (results.some((r) => !r.ok)) throw new AiError('rate_limited');
}

const tooBigForAnthropic = (p: AiRequest['parts'][number]) =>
	'data' in p && p.mime.startsWith('image/') && Math.floor((p.data.length * 3) / 4) > ANTHROPIC_IMAGE_MAX;

export const keyAad = (tenantId: string) => `ai:${tenantId}`;

export function openKey(keyEnc: string, tenantId: string): string {
	try {
		return decrypt(keyEnc, undefined, keyAad(tenantId));
	} catch {
		throw new AiError('no_key', 'key');
	}
}

async function planFor(who: Who, feature: UsageFeature): Promise<Plan> {
	const { s, tz } = await withTenant(who.ctx, async (tx) => {
		const [row] = await tx.select().from(aiSettings);
		const [t] = await tx.select({ tz: tenantSettings.timezone }).from(tenantSettings);
		return { s: row, tz: t?.tz ?? 'UTC' };
	});
	if (!s?.enabled || (feature !== 'test' && !s.features?.[feature as AiFeature])) throw new AiError('disabled');
	const base = { tenantId: who.tenantId, tz, budget: s.monthlyTokenBudget };
	if (s.keyEnc)
		return {
			...base,
			provider: s.provider as AiProvider,
			key: openKey(s.keyEnc, who.tenantId),
			pinned: s.model,
			platform: false
		};
	const c = config();
	if (!c.AI_PLATFORM_GEMINI || !c.GEMINI_API_KEY) throw new AiError('no_key');
	if (!who.aiPlatform) throw new AiError('unavailable');
	return {
		...base,
		provider: 'gemini',
		key: c.GEMINI_API_KEY,
		pinned: null,
		budget: Math.min(s.monthlyTokenBudget, c.AI_PLATFORM_MONTHLY_TOKENS),
		platform: true
	};
}

export async function recordUsage(
	who: Who,
	row: {
		feature: UsageFeature;
		provider: AiProvider;
		model: string | null;
		input: number;
		output: number;
		error: string | null;
	}
): Promise<void> {
	await withTenant(who.ctx, (tx) =>
		tx.insert(aiUsage).values({
			tenantId: who.tenantId,
			membershipId: who.membershipId,
			feature: row.feature,
			provider: row.provider,
			model: row.model,
			inputTokens: row.input,
			outputTokens: row.output,
			ok: !row.error,
			errorCode: row.error
		})
	).catch((err: Error) => log.warn({ err: err.message }, 'ai usage row failed'));
}

export async function generate(m: Member, feature: AiFeature, req: AiRequest, deadlineMs?: number): Promise<AiResult> {
	guardNoTx();
	if (!can(m.access, 'ai.use')) throw new AiError('disabled');
	await limits(m, feature);
	return call(whoOf(m), feature, req, deadlineMs);
}

export const generateForTenant = (
	tenantId: string,
	aiPlatform: boolean,
	feature: AiFeature,
	req: AiRequest,
	deadlineMs?: number
): Promise<AiResult> => {
	guardNoTx();
	return call(
		{ tenantId, aiPlatform, ctx: systemCtx(tenantId), membershipId: null },
		feature,
		req,
		deadlineMs,
		'index'
	);
};

const TEST_REQ: AiRequest = {
	system: 'You are a connection test.',
	parts: [{ text: 'Reply with the word OK.' }],
	maxOutputTokens: 16
};

export async function testPlatform(m: Member): Promise<string> {
	guardNoTx();
	if (!can(m.access, 'ai.use')) throw new AiError('disabled');
	await limits(m, 'test');
	return (await call(whoOf(m), 'test', TEST_REQ)).model;
}

async function call(
	who: Who,
	feature: UsageFeature,
	req: AiRequest,
	deadlineMs?: number,
	usageAs: UsageFeature = feature
): Promise<AiResult> {
	const p = await planFor(who, feature);
	if (p.provider === 'anthropic' && req.parts.some(tooBigForAnthropic)) throw new AiError('file_too_large');
	const estimate = estimateTokens(req);
	await reserve(who, p, estimate);
	const c = config();
	try {
		const result = await runChain(await liveChain(p.provider, p.key, p.pinned), p.key, req, {
			transport: transportFor(p.provider),
			cooling: cooling(p.key),
			deadline: Date.now() + (deadlineMs ?? c.AI_DEADLINE_MS),
			callTimeoutMs: c.AI_CALL_TIMEOUT_MS
		});
		await settle(p, result.usage.input + result.usage.output - estimate);
		await recordUsage(who, {
			feature: usageAs,
			provider: p.provider,
			model: result.model,
			input: result.usage.input,
			output: result.usage.output,
			error: null
		});
		return result;
	} catch (raw) {
		const err = raw instanceof AiError ? raw : new AiError('unavailable');
		await settle(p, -estimate);
		await recordUsage(who, {
			feature: usageAs,
			provider: p.provider,
			model: null,
			input: 0,
			output: 0,
			error: err.code
		});
		log.warn({ code: err.code, provider: p.provider, feature: usageAs }, 'ai call failed');
		throw err;
	}
}

export async function testKey(
	m: Member,
	provider: AiProvider,
	key: string
): Promise<{ models: string[]; model: string }> {
	guardNoTx();
	const r = await hit('ai_admin', m.access.membershipId, config().RL_AI_ADMIN_PER_MIN, 60_000).catch(() => {
		throw new AiError('unavailable');
	});
	if (!r.ok) throw new AiError('rate_limited');
	const models = await listModels(provider, key, true);
	try {
		const result = await runChain(chainFor(provider, null, models), key, TEST_REQ, {
			transport: transportFor(provider),
			cooling: cooling(key),
			deadline: Date.now() + config().AI_DEADLINE_MS,
			callTimeoutMs: config().AI_CALL_TIMEOUT_MS
		});
		await recordUsage(whoOf(m), {
			feature: 'test',
			provider,
			model: result.model,
			input: result.usage.input,
			output: result.usage.output,
			error: null
		});
		return { models, model: result.model };
	} catch (raw) {
		const err = raw instanceof AiError ? raw : new AiError('unavailable');
		await recordUsage(whoOf(m), { feature: 'test', provider, model: null, input: 0, output: 0, error: err.code });
		throw err;
	}
}

export const AI_USAGE_KEEP_MONTHS = 13;

export async function purgeAiUsage() {
	const list = await authPool().db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
	await list.reduce<Promise<void>>((prior, t) => prior.then(() => purgeFor(t.id)), Promise.resolve());
}

async function purgeFor(tenantId: string) {
	await withTenant(systemCtx(tenantId), (tx) =>
		tx
			.delete(aiUsage)
			.where(
				lt(
					aiUsage.createdAt,
					sql`${now().toISOString()}::timestamptz - make_interval(months => ${AI_USAGE_KEEP_MONTHS}::int)`
				)
			)
	).catch((err) => log.error({ tenantId, err: (err as Error).message }, 'ai usage purge failed'));
}
