import { config } from '../config';
import { hit } from '../ratelimit';
import { redisReady, rkey } from '../redis';
import { sha256 } from './crypto';

const WINDOW_MS = 15 * 60_000;
const PAIR_GATE_CAP_MS = 60_000;
const EMAIL_GATE_CAP_MS = 3_000;
const INFLIGHT_MS = 5_000;
const STEP_UP_DISTINCT_IPS = 3;

export type Gate = { ok: true } | { ok: false; retryAfter: number };

const id = (email: string) => sha256(email.trim().toLowerCase()).slice(0, 32);
const k = (...parts: string[]) => rkey('login', ...parts);
const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
const backoff = (fails: number, cap: number) => (fails < 3 ? 0 : Math.min(cap, 1000 * 2 ** (fails - 3)));

export async function checkLogin(email: string, ip: string, trusted: boolean): Promise<Gate> {
	const perIp = await hit('login-ip', ip, config().RL_LOGIN_PER_IP_PER_MIN, 60_000);
	if (!perIp.ok) return { ok: false, retryAfter: perIp.retryAfter };
	const r = await redisReady();
	const e = id(email);
	const [[, fails], [, pairFailsTtl], [, pairGate], [, emailGate]] = (await r
		.multi()
		.get(k('pf', e, ip))
		.pttl(k('pf', e, ip))
		.pttl(k('pg', e, ip))
		.pttl(k('eg', e))
		.exec()) as [Error | null, unknown][];
	if (Number(fails ?? 0) >= config().RL_LOGIN_PER_EMAIL_IP_15MIN)
		return { ok: false, retryAfter: seconds(Number(pairFailsTtl)) };
	if (Number(pairGate) > 0) return { ok: false, retryAfter: seconds(Number(pairGate)) };
	if (!trusted && Number(emailGate) > 0) return { ok: false, retryAfter: seconds(Number(emailGate)) };
	const acquired = await r.set(k('if', e), '1', 'PX', INFLIGHT_MS, 'NX');
	return acquired ? { ok: true } : { ok: false, retryAfter: 1 };
}

export async function loginFailed(email: string, ip: string): Promise<void> {
	const r = await redisReady();
	const e = id(email);
	const res = await r
		.multi()
		.incr(k('pf', e, ip))
		.pexpire(k('pf', e, ip), WINDOW_MS)
		.incr(k('ef', e))
		.pexpire(k('ef', e), WINDOW_MS, 'NX')
		.sadd(k('ips', e), ip)
		.pexpire(k('ips', e), WINDOW_MS)
		.del(k('if', e))
		.exec();
	const pairFails = Number(res?.[0][1] ?? 0);
	const emailFails = Number(res?.[2][1] ?? 0);
	const pairDelay = backoff(pairFails, PAIR_GATE_CAP_MS);
	const emailDelay = backoff(emailFails, EMAIL_GATE_CAP_MS);
	const m = r.multi();
	if (pairDelay) m.set(k('pg', e, ip), '1', 'PX', pairDelay);
	if (emailDelay) m.set(k('eg', e), '1', 'PX', emailDelay);
	await m.exec();
}

export async function loginSucceeded(email: string, ip: string): Promise<void> {
	const e = id(email);
	await (await redisReady()).del(k('pf', e, ip), k('pg', e, ip), k('if', e));
}

export async function releaseLogin(email: string): Promise<void> {
	await (await redisReady()).del(k('if', id(email)));
}

export async function stepUpRequired(email: string, trusted: boolean): Promise<boolean> {
	if (trusted) return false;
	return (await (await redisReady()).scard(k('ips', id(email)))) >= STEP_UP_DISTINCT_IPS;
}
