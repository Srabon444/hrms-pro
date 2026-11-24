import { once } from 'node:events';
import { Redis } from 'ioredis';
import { config } from './config';
import { log } from './log';

let client: Redis | undefined;

export function redis(): Redis {
	if (client) return client;
	client = new Redis(config().REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
	client.on('error', (err) => log.warn({ err: err.message }, 'redis error'));
	return client;
}

export async function redisReady(timeoutMs = 2000): Promise<Redis> {
	const c = redis();
	if (c.status !== 'ready') await once(c, 'ready', { signal: AbortSignal.timeout(timeoutMs) });
	return c;
}

export function rkey(...parts: (string | number)[]): string {
	return [config().REDIS_PREFIX, ...parts].join(':');
}

export async function closeRedis(): Promise<void> {
	if (!client) return;
	const c = client;
	client = undefined;
	await c.quit().catch(() => c.disconnect());
}
