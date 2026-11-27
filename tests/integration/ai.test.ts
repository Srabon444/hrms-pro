import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { estimateTokens, generate, keyAad, purgeAiUsage } from '../../src/lib/server/ai/service';
import { aiView, removeAiKey, saveAi, testAi } from '../../src/lib/server/ai/settings';
import { decrypt, encrypt } from '../../src/lib/server/auth/crypto';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { aiSettings, aiUsage } from '../../src/lib/server/db/schema';
import { log } from '../../src/lib/server/log';
import { addMember, seedTenant, setTenantAi } from '../../src/lib/server/platform/tenants';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { can, loadAccess, requirePerm, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { isRestricted, SYSTEM_ROLES } from '../../src/lib/rbac/permissions';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { actions } from '../../src/routes/t/[slug]/settings/ai/+page.server';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let a: Tenant;
let b: Tenant;
let owner: Member;
let ownerB: Member;
const staff: Member[] = [];
const sql = () => ownerPool().sql;
const req = {
	system: 'You answer HR questions.',
	parts: [{ text: 'How many leave days do I have?' }],
	maxOutputTokens: 100
};

async function member(t: Tenant, roleKeys: string[], aiPlatform = true): Promise<Member> {
	const u = await createUser();
	const id = await withTenant(systemCtx(t.id), (tx) => addMember(tx, t.id, u.id, roleKeys));
	return {
		user: { userId: u.id },
		tenant: { id: t.id, slug: t.slug, name: t.slug, require2faForSensitive: false, aiPlatform },
		access: await loadAccess(t.id, { id, status: 'active', employeeId: null })
	} as unknown as Member;
}

const form = (v: Record<string, string | string[]>) => {
	const f = new FormData();
	for (const [k, val] of Object.entries(v)) [val].flat().forEach((x) => f.append(k, x));
	return f;
};
const base = { provider: 'gemini', model: '', apiKey: '', budget: '2000000', features: ['ask', 'ocr', 'write'] };
const enable = (m: Member, extra: Record<string, string | string[]> = {}) =>
	saveAi(m, form({ ...base, enabled: 'on', consent: 'on', ...extra }));
const code = (p: Promise<unknown>) =>
	p.then(
		() => 'ok',
		(e: { code?: string; message: string }) => e.code ?? e.message
	);
const settingsOf = async (tenantId: string) =>
	(
		await sql()<{ key_enc: string | null; key_hint: string | null; model: string | null; provider: string }[]>`
		select key_enc, key_hint, model, provider from ai_settings where tenant_id = ${tenantId}`
	)[0];
const storeKey = (provider: string, key: string) => sql()`
	update ai_settings set provider = ${provider}, model = null, key_enc = ${encrypt(key, undefined, keyAad(a.id))}, key_hint = ${key.slice(-4)}
	where tenant_id = ${a.id}`;
const clearBudget = async (tenantId: string) => {
	const r = await redisReady();
	const keys = await r.keys(`${rkey('t', tenantId, 'ai')}*`);
	if (keys.length) await r.del(...keys);
};

beforeAll(async () => {
	a = await createTenant('aia');
	b = await createTenant('aib');
	await withTenant(systemCtx(a.id), (tx) => seedTenant(tx, a.id, TEST_LOCALE));
	await withTenant(systemCtx(b.id), (tx) => seedTenant(tx, b.id, TEST_LOCALE));
	owner = await member(a, ['owner']);
	ownerB = await member(b, ['owner']);
	staff.push(...(await Promise.all(Array.from({ length: 6 }, () => member(a, ['employee'])))));
});

afterAll(async () => {
	await closeRedis();
	await closePools();
});

describe('AI permissions', () => {
	it('ai.manage is restricted and only owners hold it; every employee may use AI on their own', () => {
		expect(isRestricted('ai.manage')).toBe(true);
		expect(SYSTEM_ROLES.find((r) => r.key === 'employee')?.grants).toContainEqual(['ai.use', 'own']);
		expect(can(owner.access, 'ai.manage')).toBe(true);
		expect(can(staff[0].access, 'ai.manage')).toBe(false);
		expect(can(staff[0].access, 'ai.use')).toBe(true);
		const locals = { user: staff[0].user, tenant: staff[0].tenant, access: staff[0].access } as never;
		expect(() => requirePerm(locals, 'ai.manage')).toThrow();
	});
});

describe('AI settings', () => {
	it('stays off until an owner turns it on with consent', async () => {
		expect(await code(generate(staff[0], 'ask', req))).toBe('disabled');
		expect(await code(saveAi(owner, form({ ...base, enabled: 'on' })))).toBe('consent');
		await enable(owner);
		const r = await generate(staff[0], 'ask', req);
		expect(r.model).toBe('gemini-4-neon');
		const rows = await sql()`select feature, ok, membership_id from ai_usage where tenant_id = ${a.id}`;
		expect(rows).toContainEqual({ feature: 'ask', ok: true, membership_id: staff[0].access.membershipId });
	});

	it('refuses to pin a model on the platform key and refuses bad model ids', async () => {
		expect(await code(enable(owner, { model: 'gemini-4-flash' }))).toBe('model');
		expect(await code(enable(owner, { model: '../../evil?x=1' }))).toBe('invalid');
		expect(await code(enable(owner, { provider: 'openai' }))).toBe('provider_key');
	});

	it('tests a new key before saving it, then stores it encrypted to this tenant only', async () => {
		const leaked: string[] = [];
		const spies = (['info', 'warn', 'error'] as const).map((l) =>
			vi.spyOn(log, l).mockImplementation(((...args: unknown[]) => leaked.push(JSON.stringify(args))) as never)
		);
		expect(await code(enable(owner, { apiKey: 'bad-key-QQQQ' }))).toBe('key_invalid');
		expect((await settingsOf(a.id)).key_hint).toBeNull();

		const res = await actions.save({
			request: new Request('http://x', {
				method: 'POST',
				body: form({ ...base, enabled: 'on', apiKey: 'quota-key-ZZZZ' })
			}),
			locals: { user: owner.user, tenant: owner.tenant, access: owner.access, requestId: 'r1' }
		} as never);
		expect(JSON.stringify(res)).not.toContain('quota-key-ZZZZ');
		expect(JSON.stringify(res)).toContain('no quota');

		await enable(owner, { provider: 'openai', apiKey: 'tenant-openai-key-1234', model: 'openai-fake-extra' });
		const s = await settingsOf(a.id);
		expect(s).toMatchObject({ key_hint: '…1234', provider: 'openai', model: 'openai-fake-extra' });
		expect(s.key_enc).not.toContain('tenant-openai-key');
		expect(decrypt(s.key_enc!, undefined, keyAad(a.id))).toBe('tenant-openai-key-1234');
		expect(() => decrypt(s.key_enc!, undefined, keyAad(b.id))).toThrow();

		expect((await generate(staff[1], 'write', req)).model).toBe('openai-fake-extra');
		const audit = await sql()`
			select l.event, l.new_values, s.new_values as sensitive from audit_log l
			left join audit_sensitive s on s.audit_id = l.id
			where l.tenant_id = ${a.id} and l.table_name = 'ai_settings'`;
		expect(JSON.stringify(audit)).not.toContain('tenant-openai-key');
		expect(audit.find((r) => r.event === 'ai.key_set')?.new_values).toEqual({ provider: 'openai', hint: '…1234' });
		spies.forEach((s) => s.mockRestore());
		expect(leaked.join('')).not.toMatch(/tenant-openai-key|bad-key-QQQQ|quota-key-ZZZZ/);
	});

	it('keeps the stored key on a blank save and refuses a model the key cannot list', async () => {
		expect(await code(enable(owner, { provider: 'openai', model: 'gpt-made-up' }))).toBe('model');
		await enable(owner, { provider: 'openai' });
		expect((await settingsOf(a.id)).key_hint).toBe('…1234');
	});

	it('cannot be read from another tenant', async () => {
		const rows = await withTenant(userCtx(ownerB), async (tx) => ({
			s: await tx.select().from(aiSettings),
			u: await tx.select().from(aiUsage)
		}));
		expect(rows.s).toHaveLength(0);
		expect(rows.u).toHaveLength(0);
		expect(await code(generate(ownerB, 'ask', req))).toBe('disabled');
	});
});

describe('AI settings found by the attack pass', () => {
	it('tests the platform key only while AI is on and within the budget', async () => {
		const c = await createTenant('aic');
		await withTenant(systemCtx(c.id), (tx) => seedTenant(tx, c.id, TEST_LOCALE));
		const o = await member(c, ['owner']);
		expect(await code(testAi(o))).toBe('disabled');
		await saveAi(o, form({ ...base, enabled: 'on', consent: 'on', budget: '10' }));
		expect(await code(testAi(o))).toBe('budget');
		await saveAi(o, form({ ...base, enabled: 'on', budget: '1000' }));
		expect(await testAi(o)).toEqual({ model: 'gemini-4-neon', platform: true });
		const [{ n }] =
			await sql()`select count(*)::int as n from ai_usage where tenant_id = ${c.id} and feature = 'test' and ok`;
		expect(n).toBe(1);
	});

	it('refuses a blank budget or a too short key instead of saving zero', async () => {
		expect(await code(saveAi(owner, form({ ...base, enabled: 'on', budget: '  ' })))).toBe('invalid');
		expect(await code(saveAi(owner, form({ provider: 'gemini', features: ['ask'] })))).toBe('invalid');
		expect(await code(enable(owner, { apiKey: 'abc' }))).toBe('invalid');
	});

	it('keeps a pinned model when the model list cannot be fetched', async () => {
		await enable(owner, { provider: 'openai', apiKey: 'pin-key-2468', model: 'openai-fake-extra' });
		await storeKey('openai', 'bad-now-2468');
		await sql()`update ai_settings set model = 'openai-fake-extra' where tenant_id = ${a.id}`;
		expect((await aiView(owner)).models).toEqual([]);
		await enable(owner, { provider: 'openai', model: 'openai-fake-extra', budget: '3000000' });
		expect((await settingsOf(a.id)).model).toBe('openai-fake-extra');
		await enable(owner, { provider: 'openai', apiKey: 'tenant-openai-key-1234' });
	});
});

describe('AI calls', () => {
	it('never runs inside a database transaction', async () => {
		await expect(withTenant(userCtx(staff[0]), () => generate(staff[0], 'ask', req))).rejects.toThrow(
			'inside a database transaction'
		);
	});

	it('honours the per-feature switch', async () => {
		await enable(owner, { provider: 'openai', features: ['ask'] });
		expect(await code(generate(staff[0], 'ocr', req))).toBe('disabled');
		await enable(owner, { provider: 'openai' });
	});

	it('stops at the monthly budget, and parallel calls never overshoot it', async () => {
		await enable(owner, { provider: 'openai', apiKey: 'delay-key-5678', budget: '1000' });
		await clearBudget(a.id);
		await sql()`delete from ai_usage where tenant_id = ${a.id}`;
		const calls = staff.slice(0, 4).flatMap((m) => Array.from({ length: 5 }, () => code(generate(m, 'ask', req))));
		const results = await Promise.all(calls);
		const ok = results.filter((r) => r === 'ok').length;
		expect(ok).toBe(Math.floor(1000 / estimateTokens(req)));
		expect(results.filter((r) => r === 'budget')).toHaveLength(20 - ok);
		const r = await redisReady();
		const used = Number(
			await r.get(
				rkey(
					't',
					a.id,
					'ai',
					'tok',
					(
						await sql()`select to_char(now() at time zone s.timezone, 'YYYYMM') as m from tenant_settings s where tenant_id = ${a.id}`
					)[0].m
				)
			)
		);
		const [{ tokens }] =
			await sql()`select coalesce(sum(input_tokens + output_tokens), 0)::int as tokens from ai_usage where tenant_id = ${a.id}`;
		expect(used).toBe(tokens);
		await enable(owner, { provider: 'openai', budget: '50' });
		expect(await code(generate(staff[5], 'ask', req))).toBe('budget');
	});

	it('never leaves a negative counter when the month key vanishes mid-call', async () => {
		await enable(owner, { provider: 'openai', apiKey: 'delay-key-1357', budget: '2000000' });
		await clearBudget(a.id);
		const pending = generate(staff[5], 'ask', req);
		await new Promise((r) => setTimeout(r, 60));
		await clearBudget(a.id);
		await pending;
		const r = await redisReady();
		expect(await r.keys(`${rkey('t', a.id, 'ai', 'tok')}*`)).toEqual([]);
	});

	it('rebuilds a lost month counter from usage rows', async () => {
		await enable(owner, { provider: 'openai', budget: '2000000' });
		await clearBudget(a.id);
		await generate(staff[5], 'ask', req);
		const [{ tokens }] =
			await sql()`select coalesce(sum(input_tokens + output_tokens), 0)::int as tokens from ai_usage where tenant_id = ${a.id}`;
		const r = await redisReady();
		const [k] = await r.keys(`${rkey('t', a.id, 'ai', 'tok')}*`);
		expect(Number(await r.get(k))).toBe(tokens);
	});

	it('rate limits a person past 20 calls a minute', async () => {
		const m = await member(a, ['employee']);
		const results = await Promise.all(Array.from({ length: 21 }, () => code(generate(m, 'ask', req))));
		expect(results.filter((r) => r === 'rate_limited')).toHaveLength(1);
	});

	it('gives up at the deadline and records the failure', async () => {
		await storeKey('gemini', 'slow-key-9999');
		const started = Date.now();
		expect(await code(generate(staff[2], 'ask', req, 300))).toBe('timeout');
		expect(Date.now() - started).toBeLessThan(5000);
		const [row] =
			await sql()`select ok, error_code from ai_usage where membership_id = ${staff[2].access.membershipId} order by created_at desc limit 1`;
		expect(row).toEqual({ ok: false, error_code: 'timeout' });
	});

	it('cools a busy model and moves to the next one', async () => {
		await enable(owner, { provider: 'gemini', apiKey: 'busy-key-4321' });
		expect((await generate(staff[3], 'ask', req)).model).toBe('gemini-4-flash');
		expect((await generate(staff[3], 'ask', req)).model).toBe('gemini-4-flash');
	});

	it('uses the platform key only while the platform allows the tenant, and the own key either way', async () => {
		await removeAiKey(owner);
		expect((await settingsOf(a.id)).key_enc).toBeNull();
		await setTenantAi(a.id, false, owner.user.userId);
		const off = { ...staff[4], tenant: { ...staff[4].tenant, aiPlatform: false } } as Member;
		expect(await code(generate(off, 'ask', req))).toBe('unavailable');
		await enable(owner, { provider: 'anthropic', apiKey: 'own-anthropic-key-0000' });
		expect((await generate(off, 'ask', req)).model).toBe('claude-sonnet-5-5');
		await setTenantAi(a.id, true, owner.user.userId);
		const [{ ai_platform }] = await sql()`select ai_platform from tenants where id = ${a.id}`;
		expect(ai_platform).toBe(true);
		const audit = await sql()`select action from platform_audit where target = ${a.id} order by created_at`;
		expect(audit.map((r) => r.action)).toEqual(['tenant.ai_platform_off', 'tenant.ai_platform_on']);
	});

	it('drops usage rows older than 13 months', async () => {
		await sql()`insert into ai_usage (tenant_id, membership_id, feature, provider, ok, created_at)
			values (${a.id}, ${staff[0].access.membershipId}, 'ask', 'gemini', true, now() - interval '14 months'),
			       (${a.id}, ${staff[0].access.membershipId}, 'ask', 'gemini', true, now() - interval '12 months')`;
		await purgeAiUsage();
		const [{ n }] =
			await sql()`select count(*)::int as n from ai_usage where tenant_id = ${a.id} and created_at < now() - interval '11 months'`;
		expect(n).toBe(1);
		const [{ m }] = await sql()`select count(*)::int as m from memberships where id = ${staff[0].access.membershipId}`;
		expect(m).toBe(1);
	});
});
