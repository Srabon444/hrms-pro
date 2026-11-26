import { config } from './config';
import { log } from './log';
import { rateLimited } from './metrics';
import { redisReady, rkey } from './redis';

export type Hit = { ok: boolean; count: number; retryAfter: number };

export async function hit(bucket: string, id: string, limit: number, windowMs: number): Promise<Hit> {
	const r = await redisReady();
	const key = rkey('rl', bucket, id);
	const res = await r.multi().incr(key).pexpire(key, windowMs, 'NX').pttl(key).exec();
	const failed = res?.find(([err]) => err);
	if (!res || failed) throw failed?.[0] ?? new Error('rate limit transaction aborted');
	const count = Number(res[0][1]);
	const ok = count <= limit;
	if (!ok) rateLimited.inc({ bucket });
	return { ok, count, retryAfter: Math.max(1, Math.ceil(Number(res[2][1]) / 1000)) };
}

const local = new Map<string, { count: number; resetAt: number }>();

function localHit(bucket: string, id: string, limit: number, windowMs: number): Hit {
	const now = Date.now();
	if (local.size > 10_000) for (const [k, w] of local) if (w.resetAt <= now) local.delete(k);
	const key = `${bucket}:${id}`;
	const prev = local.get(key);
	const w = prev && prev.resetAt > now ? prev : { count: 0, resetAt: now + windowMs };
	w.count += 1;
	local.set(key, w);
	const ok = w.count <= limit;
	if (!ok) rateLimited.inc({ bucket });
	return { ok, count: w.count, retryAfter: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
}

export const hitOrLocal = (bucket: string, id: string, limit: number, windowMs: number): Promise<Hit> =>
	hit(bucket, id, limit, windowMs).catch((err) => {
		log.warn({ bucket, err: (err as Error).message }, 'redis rate limit unavailable; counting in memory');
		return localHit(bucket, id, limit, windowMs);
	});

export async function overLimit(bucket: string, id: string, limit: number): Promise<boolean> {
	try {
		return Number((await (await redisReady()).get(rkey('rl', bucket, id))) ?? 0) >= limit;
	} catch {
		const w = local.get(`${bucket}:${id}`);
		return !!w && w.resetAt > Date.now() && w.count >= limit;
	}
}

export async function downloadLimit(userId: string): Promise<Response | null> {
	const r = await hitOrLocal('download', userId, config().RL_DOWNLOADS_PER_USER_MIN, 60_000);
	if (r.ok) return null;
	return new Response('Too many downloads', { status: 429, headers: { 'retry-after': String(r.retryAfter) } });
}

export async function searchLimit(membershipId: string): Promise<Response | null> {
	const r = await hitOrLocal('search', membershipId, config().RL_SEARCH_PER_USER_MIN, 60_000);
	if (r.ok) return null;
	return new Response('Too many searches', { status: 429, headers: { 'retry-after': String(r.retryAfter) } });
}
