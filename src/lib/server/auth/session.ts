import { and, eq, ne } from 'drizzle-orm';
import { now } from '../clock';
import { AppError } from '../errors';
import { authPool } from '../db';
import { sessions, users } from '../db/schema';
import { log } from '../log';
import { redisReady, rkey } from '../redis';
import { randomToken, sha256 } from './crypto';

export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600_000;
const IDLE_MS = 7 * 24 * 3600_000;
const TOUCH_MS = 60_000;
const CACHE_SECONDS = 60;

export type SessionUser = {
	sessionId: string;
	userId: string;
	email: string;
	name: string;
	isPlatformAdmin: boolean;
	totpEnabled: boolean;
};

type Cached = SessionUser & { expiresAt: number; idleExpiresAt: number; lastSeenAt: number };

const cacheKey = (id: string) => rkey('sess', id);

async function cacheGet(id: string): Promise<Cached | null> {
	try {
		const raw = await (await redisReady()).get(cacheKey(id));
		return raw ? (JSON.parse(raw) as Cached) : null;
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'session cache read failed');
		return null;
	}
}

async function cacheSet(row: Cached): Promise<void> {
	try {
		await (await redisReady()).set(cacheKey(row.sessionId), JSON.stringify(row), 'EX', CACHE_SECONDS);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'session cache write failed');
	}
}

async function cacheDrop(ids: string[]): Promise<void> {
	if (!ids.length) return;
	try {
		await (await redisReady()).del(...ids.map(cacheKey));
	} catch (err) {
		log.error({ err: (err as Error).message }, 'session cache invalidation failed');
	}
}

export async function createSession(
	userId: string,
	meta: { ip?: string | null; userAgent?: string | null }
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomToken();
	const t = now();
	const expiresAt = new Date(t.getTime() + SESSION_ABSOLUTE_MS);
	await authPool()
		.db.insert(sessions)
		.values({
			id: sha256(token),
			userId,
			expiresAt,
			idleExpiresAt: new Date(t.getTime() + IDLE_MS),
			lastSeenAt: t,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent?.slice(0, 300) ?? null
		});
	await authPool().db.update(users).set({ lastLoginAt: t }).where(eq(users.id, userId));
	return { token, expiresAt };
}

async function load(id: string): Promise<Cached | null> {
	const [row] = await authPool()
		.db.select({
			sessionId: sessions.id,
			userId: users.id,
			email: users.email,
			name: users.name,
			isPlatformAdmin: users.isPlatformAdmin,
			totpEnabled: users.totpEnabled,
			expiresAt: sessions.expiresAt,
			idleExpiresAt: sessions.idleExpiresAt,
			lastSeenAt: sessions.lastSeenAt
		})
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(and(eq(sessions.id, id), eq(users.status, 'active')));
	if (!row) return null;
	return {
		...row,
		expiresAt: row.expiresAt.getTime(),
		idleExpiresAt: row.idleExpiresAt.getTime(),
		lastSeenAt: row.lastSeenAt.getTime()
	};
}

export async function validateSession(token: string | undefined): Promise<SessionUser | null> {
	if (!token || token.length > 100) return null;
	const id = sha256(token);
	const cached = await cacheGet(id);
	const row = cached ?? (await load(id));
	if (!row) return null;
	const t = now().getTime();
	if (t >= row.expiresAt || t >= row.idleExpiresAt) {
		await authPool().db.delete(sessions).where(eq(sessions.id, id));
		await cacheDrop([id]);
		return null;
	}
	if (t - row.lastSeenAt > TOUCH_MS) {
		row.lastSeenAt = t;
		row.idleExpiresAt = Math.min(row.expiresAt, t + IDLE_MS);
		await authPool()
			.db.update(sessions)
			.set({ lastSeenAt: new Date(t), idleExpiresAt: new Date(row.idleExpiresAt) })
			.where(eq(sessions.id, id));
		await cacheSet(row);
	} else if (!cached) await cacheSet(row);
	return {
		sessionId: row.sessionId,
		userId: row.userId,
		email: row.email,
		name: row.name,
		isPlatformAdmin: row.isPlatformAdmin,
		totpEnabled: row.totpEnabled
	};
}

export async function deleteSession(token: string | undefined): Promise<void> {
	if (!token) return;
	const id = sha256(token);
	await authPool().db.delete(sessions).where(eq(sessions.id, id));
	await cacheDrop([id]);
}

export async function deleteUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
	const where = exceptSessionId
		? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
		: eq(sessions.userId, userId);
	const gone = await authPool().db.delete(sessions).where(where).returning({ id: sessions.id });
	await cacheDrop(gone.map((s) => s.id));
}

export async function refreshUserSessions(userId: string): Promise<void> {
	const ids = await authPool().db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
	await cacheDrop(ids.map((s) => s.id));
}

export async function markReauth(sessionId: string): Promise<void> {
	await authPool().db.update(sessions).set({ reauthAt: now() }).where(eq(sessions.id, sessionId));
}

export async function recentlyAuthed(sessionId: string, minutes: number): Promise<boolean> {
	const [row] = await authPool().db.select({ at: sessions.reauthAt }).from(sessions).where(eq(sessions.id, sessionId));
	const age = row?.at ? now().getTime() - row.at.getTime() : Infinity;
	return age >= 0 && age <= minutes * 60_000;
}

export async function requireRecentAuth(sessionId: string, minutes: number): Promise<void> {
	if (!(await recentlyAuthed(sessionId, minutes)))
		throw new AppError('reauth_required', 'Confirm your password to continue.', 403);
}
