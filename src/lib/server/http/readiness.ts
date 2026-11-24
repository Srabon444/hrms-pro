import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { appPool } from '../db';
import { redisReady } from '../redis';
import { s3 } from '../storage';
import { config } from '../config';

type Check = { ok: boolean; ms: number; error?: string };

async function timed(fn: () => Promise<unknown>): Promise<Check> {
	const start = performance.now();
	try {
		await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
		return { ok: true, ms: Math.round(performance.now() - start) };
	} catch (err) {
		return { ok: false, ms: Math.round(performance.now() - start), error: (err as Error).message };
	}
}

export async function readiness(): Promise<{ ok: boolean; checks: Record<string, Check> }> {
	const [db, cache, storage] = await Promise.all([
		timed(() => appPool().sql`select 1`),
		timed(async () => (await redisReady()).ping()),
		timed(() => s3().send(new HeadBucketCommand({ Bucket: config().S3_BUCKET })))
	]);
	const checks = { db, redis: cache, storage };
	return { ok: Object.values(checks).every((c) => c.ok), checks };
}
