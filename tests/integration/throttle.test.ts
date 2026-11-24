import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
	checkLogin,
	loginFailed,
	loginSucceeded,
	releaseLogin,
	stepUpRequired
} from '../../src/lib/server/auth/throttle';
import { hit } from '../../src/lib/server/ratelimit';
import { closeRedis } from '../../src/lib/server/redis';

afterAll(closeRedis);

const email = () => `${randomUUID()}@test.local`;
const ip = () =>
	`10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

describe('fixed window limiter', () => {
	it('allows up to the limit, then reports retry-after within the window', async () => {
		const id = randomUUID();
		for (let i = 0; i < 3; i++) expect((await hit('probe', id, 3, 10_000)).ok).toBe(true);
		const blocked = await hit('probe', id, 3, 10_000);
		expect(blocked.ok).toBe(false);
		expect(blocked.retryAfter).toBeGreaterThan(0);
		expect(blocked.retryAfter).toBeLessThanOrEqual(10);
	});
});

describe('login throttle', () => {
	it('allows one verification in flight per email', async () => {
		const e = email();
		expect(await checkLogin(e, ip(), false)).toEqual({ ok: true });
		expect((await checkLogin(e, ip(), false)).ok).toBe(false);
		await releaseLogin(e);
		expect((await checkLogin(e, ip(), false)).ok).toBe(true);
	});

	it('blocks the (email, ip) pair after five failures but not the same email from a trusted device elsewhere', async () => {
		const e = email();
		const bad = ip();
		for (let i = 0; i < 5; i++) await loginFailed(e, bad);
		const blocked = await checkLogin(e, bad, true);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.retryAfter).toBeGreaterThan(60);
		expect(await checkLogin(e, ip(), true)).toEqual({ ok: true });
	});

	it('caps the cross-ip email gate at three seconds', async () => {
		const e = email();
		for (let i = 0; i < 6; i++) await loginFailed(e, ip());
		const gated = await checkLogin(e, ip(), false);
		expect(gated.ok).toBe(false);
		if (!gated.ok) expect(gated.retryAfter).toBeLessThanOrEqual(3);
	});

	it('gates the pair with growing delays after the third failure and clears on success', async () => {
		const e = email();
		const addr = ip();
		for (let i = 0; i < 3; i++) await loginFailed(e, addr);
		expect((await checkLogin(e, addr, true)).ok).toBe(false);
		await loginSucceeded(e, addr);
		expect(await checkLogin(e, addr, true)).toEqual({ ok: true });
	});

	it('requires step-up after failures from three addresses unless the device is trusted', async () => {
		const e = email();
		await loginFailed(e, ip());
		await loginFailed(e, ip());
		expect(await stepUpRequired(e, false)).toBe(false);
		await loginFailed(e, ip());
		expect(await stepUpRequired(e, false)).toBe(true);
		expect(await stepUpRequired(e, true)).toBe(false);
	});

	it('limits attempts per ip across emails', async () => {
		const addr = ip();
		for (let i = 0; i < 20; i++) expect((await checkLogin(email(), addr, false)).ok).toBe(true);
		expect((await checkLogin(email(), addr, false)).ok).toBe(false);
	});
});
