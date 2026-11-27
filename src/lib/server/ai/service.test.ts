import { describe, expect, it, vi } from 'vitest';

vi.mock('../redis', () => ({
	redisReady: () => Promise.reject(new Error('redis down')),
	rkey: (...parts: string[]) => parts.join(':')
}));
vi.mock('../config', () => ({
	config: () => ({
		RL_AI_PER_USER_MIN: 20,
		RL_AI_PER_USER_DAY: 300,
		RL_AI_PER_TENANT_MIN: 200,
		RL_AI_ADMIN_PER_MIN: 10
	})
}));

const { generate, testKey } = await import('./service');
const m = {
	user: { userId: 'u' },
	tenant: { id: 't', aiPlatform: true },
	access: { membershipId: 'm', grants: { 'ai.use': ['own'] } }
} as never;
const req = { system: 's', parts: [{ text: 'x' }], maxOutputTokens: 10 };

describe('AI without redis', () => {
	it('fails closed instead of skipping limits and budget', async () => {
		await expect(generate(m, 'ask', req)).rejects.toMatchObject({ code: 'unavailable' });
		await expect(testKey(m, 'gemini', 'k')).rejects.toMatchObject({ code: 'unavailable' });
	});
});
