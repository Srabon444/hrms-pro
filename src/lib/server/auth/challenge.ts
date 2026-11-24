import { randomToken } from './crypto';
import { redisReady, rkey } from '../redis';

export type Challenge = {
	userId: string;
	email: string;
	stage: 'stepup' | 'totp';
	attempts: number;
	trusted: boolean;
	codeHash?: string;
};

export const MAX_CHALLENGE_ATTEMPTS = 5;

const key = (id: string) => rkey('chal', id);

export async function createChallenge(c: Challenge, ttlMs: number): Promise<string> {
	const id = randomToken(24);
	await (await redisReady()).set(key(id), JSON.stringify(c), 'PX', ttlMs);
	return id;
}

export async function getChallenge(id: string | undefined): Promise<Challenge | null> {
	if (!id || id.length > 64) return null;
	const raw = await (await redisReady()).get(key(id));
	return raw ? (JSON.parse(raw) as Challenge) : null;
}

export async function saveChallenge(id: string, c: Challenge): Promise<void> {
	await (await redisReady()).set(key(id), JSON.stringify(c), 'KEEPTTL', 'XX');
}

export async function dropChallenge(id: string): Promise<void> {
	await (await redisReady()).del(key(id));
}
