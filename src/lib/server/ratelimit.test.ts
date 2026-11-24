import { describe, expect, it, vi } from 'vitest';

vi.mock('./redis', () => ({
	redisReady: () => Promise.reject(new Error('redis down')),
	rkey: (...parts: string[]) => parts.join(':')
}));

const { hitOrLocal } = await import('./ratelimit');

describe('rate limit without redis', () => {
	it('keeps counting in memory and refuses past the limit', async () => {
		const id = crypto.randomUUID();
		expect((await hitOrLocal('download', id, 2, 60_000)).ok).toBe(true);
		expect((await hitOrLocal('download', id, 2, 60_000)).ok).toBe(true);
		const blocked = await hitOrLocal('download', id, 2, 60_000);
		expect(blocked.ok).toBe(false);
		expect(blocked.retryAfter).toBeGreaterThan(0);
		expect(blocked.retryAfter).toBeLessThanOrEqual(60);
		expect((await hitOrLocal('download', crypto.randomUUID(), 2, 60_000)).ok).toBe(true);
	});

	it('starts a new window once the old one ends', async () => {
		vi.useFakeTimers();
		const id = crypto.randomUUID();
		await hitOrLocal('mutation', id, 1, 1000);
		expect((await hitOrLocal('mutation', id, 1, 1000)).ok).toBe(false);
		vi.advanceTimersByTime(1001);
		expect((await hitOrLocal('mutation', id, 1, 1000)).ok).toBe(true);
		vi.useRealTimers();
	});
});
