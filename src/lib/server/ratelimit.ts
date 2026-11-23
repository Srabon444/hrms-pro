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
