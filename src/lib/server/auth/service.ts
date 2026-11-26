import { randomBytes, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { now } from '../clock';
import { config } from '../config';
import { authPool } from '../db';
import { invitations, passwordResets, tenants, users } from '../db/schema';
import { AppError } from '../errors';
import { sendMail } from '../mail';
import { hit } from '../ratelimit';
import { redisReady, rkey } from '../redis';
import {
	MAX_CHALLENGE_ATTEMPTS,
	createChallenge,
	dropChallenge,
	getChallenge,
	saveChallenge,
	type Challenge
} from './challenge';
import { decrypt, encrypt, randomToken, safeEqual, sha256, sign, unsign } from './crypto';
import { hashPassword, passwordProblem, verifyPassword } from './password';
import { createSession, deleteUserSessions, refreshUserSessions } from './session';
import { checkLogin, loginFailed, loginSucceeded, releaseLogin, stepUpRequired } from './throttle';
import { matchTotp, newTotpSecret, otpauthUri, base32Encode } from './totp';
import { createUser, emailSchema, findUserByEmail } from './users';
import { revokeUserFeeds } from '../public/tokens';

const TOTP_CHALLENGE_MS = 5 * 60_000;
const STEP_UP_CHALLENGE_MS = 10 * 60_000;
const TRUSTED_DEVICE_MS = 30 * 24 * 3600_000;
const RESET_TTL_MS = 30 * 60_000;
const HOUR = 3600_000;

type User = typeof users.$inferSelect;
type Meta = { ip: string; userAgent?: string | null };

export type LoginResult =
	| { kind: 'session'; token: string; expiresAt: Date; trustedDevice: string }
	| { kind: 'challenge'; challengeId: string; stage: Challenge['stage'] }
	| { kind: 'invalid' }
	| { kind: 'limited'; retryAfter: number };

export type ChallengeResult = LoginResult | { kind: 'wrong'; remaining: number } | { kind: 'expired' };

export function isTrustedDevice(token: string | undefined, email: string): boolean {
	const payload = unsign('device', token);
	if (!payload) return false;
	const [who, exp] = payload.split('|');
	return who === email && Number(exp) > now().getTime();
}

const trustedDeviceToken = (email: string) => sign('device', `${email}|${now().getTime() + TRUSTED_DEVICE_MS}`);

async function finish(user: User, meta: Meta): Promise<LoginResult> {
	const s = await createSession(user.id, meta);
	return { kind: 'session', token: s.token, expiresAt: s.expiresAt, trustedDevice: trustedDeviceToken(user.email) };
}

async function startStepUp(user: User, trusted: boolean): Promise<LoginResult> {
	const r = await redisReady();
	const locked = await r.pttl(rkey('stepup-lock', user.id));
	if (locked > 0) return { kind: 'limited', retryAfter: Math.ceil(locked / 1000) };
	const sends = await hit('stepup-send', user.id, 3, HOUR);
	if (!sends.ok) return { kind: 'limited', retryAfter: sends.retryAfter };
	const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
	const challengeId = await createChallenge(
		{ userId: user.id, email: user.email, stage: 'stepup', attempts: 0, trusted, codeHash: sha256(code) },
		STEP_UP_CHALLENGE_MS
	);
	await sendMail({
		to: user.email,
		subject: 'Your HRMS sign-in code',
		text: `We noticed failed sign-in attempts on your account from several places.\n\nYour sign-in code is ${code}. It expires in 10 minutes.\n\nIf this was not you, change your password.`
	});
	return { kind: 'challenge', challengeId, stage: 'stepup' };
}

async function afterPassword(user: User, meta: Meta, trusted: boolean, stepUpDone: boolean): Promise<LoginResult> {
	if (!stepUpDone && (await stepUpRequired(user.email, trusted))) return startStepUp(user, trusted);
	if (user.totpEnabled) {
		const challengeId = await createChallenge(
			{ userId: user.id, email: user.email, stage: 'totp', attempts: 0, trusted },
			TOTP_CHALLENGE_MS
		);
		return { kind: 'challenge', challengeId, stage: 'totp' };
	}
	return finish(user, meta);
}

export async function login(input: {
	email: string;
	password: string;
	meta: Meta;
	trustedDevice?: string;
}): Promise<LoginResult> {
	const parsed = emailSchema.safeParse(input.email);
	if (!parsed.success) {
		await verifyPassword(null, input.password);
		return { kind: 'invalid' };
	}
	const email = parsed.data;
	const trusted = isTrustedDevice(input.trustedDevice, email);
	const gate = await checkLogin(email, input.meta.ip, trusted);
	if (!gate.ok) return { kind: 'limited', retryAfter: gate.retryAfter };
	let user: User | undefined;
	try {
		user = await findUserByEmail(email);
		const ok = (await verifyPassword(user?.passwordHash, input.password)) && user?.status === 'active';
		if (!ok || !user) {
			await loginFailed(email, input.meta.ip);
			return { kind: 'invalid' };
		}
		await loginSucceeded(email, input.meta.ip);
	} finally {
		await releaseLogin(email);
	}
	return afterPassword(user, input.meta, trusted, false);
}

const userById = async (id: string) =>
	(
		await authPool()
			.db.select()
			.from(users)
			.where(and(eq(users.id, id), eq(users.status, 'active')))
	)[0];

async function claimTotpStep(userId: string, step: number): Promise<boolean> {
	const rows = await authPool()
		.db.update(users)
		.set({ totpLastStep: step })
		.where(and(eq(users.id, userId), sql`coalesce(${users.totpLastStep}, -1) < ${step}`))
		.returning({ id: users.id });
	return rows.length === 1;
}

const normaliseRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
	const clean = normaliseRecovery(code);
	if (clean.length !== 16) return false;
	const h = sha256(clean);
	const rows = await authPool()
		.db.update(users)
		.set({ recoveryCodes: sql`${users.recoveryCodes} - ${h}::text` })
		.where(and(eq(users.id, userId), sql`${users.recoveryCodes} @> jsonb_build_array(${h}::text)`))
		.returning({ id: users.id });
	return rows.length === 1;
}

async function wrongCode(
	id: string,
	c: Challenge,
	failBucket: string,
	limit: number,
	windowMs: number,
	lockKey: string,
	onLock?: () => Promise<void>
): Promise<ChallengeResult> {
	const fails = await hit(failBucket, c.userId, limit, windowMs);
	if (!fails.ok) {
		await (await redisReady()).set(lockKey, '1', 'PX', windowMs);
		await dropChallenge(id);
		await onLock?.();
		return { kind: 'limited', retryAfter: Math.ceil(windowMs / 1000) };
	}
	c.attempts += 1;
	if (c.attempts >= MAX_CHALLENGE_ATTEMPTS) {
		await dropChallenge(id);
		return { kind: 'expired' };
	}
	await saveChallenge(id, c);
	return { kind: 'wrong', remaining: MAX_CHALLENGE_ATTEMPTS - c.attempts };
}

export async function verifyChallenge(id: string | undefined, code: string, meta: Meta): Promise<ChallengeResult> {
	const c = await getChallenge(id);
	if (!c || !id) return { kind: 'expired' };
	const r = await redisReady();
	if (c.stage === 'stepup') {
		const lockKey = rkey('stepup-lock', c.userId);
		const locked = await r.pttl(lockKey);
		if (locked > 0) return { kind: 'limited', retryAfter: Math.ceil(locked / 1000) };
		if (!c.codeHash || !safeEqual(sha256(code.trim()), c.codeHash))
			return wrongCode(id, c, 'stepup-fail', 10, HOUR, lockKey);
		await dropChallenge(id);
		const user = await userById(c.userId);
		if (!user) return { kind: 'expired' };
		return afterPassword(user, meta, c.trusted, true);
	}
	const lockKey = rkey('totp-lock', c.userId);
	const locked = await r.pttl(lockKey);
	if (locked > 0) return { kind: 'limited', retryAfter: Math.ceil(locked / 1000) };
	const user = await userById(c.userId);
	if (!user || !user.totpEnabled || !user.totpSecretEnc) return { kind: 'expired' };
	const step = matchTotp(decrypt(user.totpSecretEnc), code.trim(), now());
	const ok =
		(step !== null && (await claimTotpStep(user.id, step))) ||
		(step === null && (await consumeRecoveryCode(user.id, code)));
	if (!ok)
		return wrongCode(id, c, 'totp-fail', config().TOTP_FAILS_PER_15MIN, 15 * 60_000, lockKey, () =>
			sendMail({
				to: user.email,
				subject: 'Two-factor sign-in locked',
				text: 'Too many wrong two-factor codes were entered for your HRMS account. Two-factor sign-in is locked for 15 minutes. If this was not you, change your password.'
			})
		);
	await dropChallenge(id);
	return finish(user, meta);
}

async function assertTotpOff(userId: string) {
	if ((await userById(userId))?.totpEnabled)
		throw new AppError('totp_enabled', 'Two-factor sign-in is already on. Turn it off with your password first.', 409);
}

export async function beginTotpEnrolment(userId: string, email: string): Promise<{ secret: string; uri: string }> {
	await assertTotpOff(userId);
	const secret = newTotpSecret();
	await (await redisReady()).set(rkey('totp-enrol', userId), secret, 'PX', 10 * 60_000);
	return { secret, uri: otpauthUri(secret, email, 'HRMS') };
}

export async function confirmTotpEnrolment(userId: string, code: string): Promise<string[]> {
	const secret = await (await redisReady()).get(rkey('totp-enrol', userId));
	if (!secret) throw new AppError('enrolment_expired', 'Setup expired, start again');
	await assertTotpOff(userId);
	const step = matchTotp(secret, code.trim(), now());
	if (step === null) throw new AppError('wrong_code', 'That code is not valid');
	const codes = Array.from({ length: 10 }, () => base32Encode(randomBytes(10)).toLowerCase());
	await authPool()
		.db.update(users)
		.set({
			totpSecretEnc: encrypt(secret),
			totpEnabled: true,
			totpLastStep: step,
			recoveryCodes: codes.map((c) => sha256(c))
		})
		.where(eq(users.id, userId));
	await (await redisReady()).del(rkey('totp-enrol', userId));
	await refreshUserSessions(userId);
	return codes.map((c) => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12)}`);
}

export async function disableTotp(userId: string, password: string): Promise<void> {
	const user = await userById(userId);
	if (!user || !(await verifyPassword(user.passwordHash, password)))
		throw new AppError('wrong_password', 'Password is incorrect');
	await authPool()
		.db.update(users)
		.set({ totpSecretEnc: null, totpEnabled: false, totpLastStep: null, recoveryCodes: [] })
		.where(eq(users.id, userId));
	await revokeUserFeeds(userId);
	await refreshUserSessions(userId);
}

export async function requestPasswordReset(rawEmail: string, ip: string): Promise<void> {
	const parsed = emailSchema.safeParse(rawEmail);
	if (!parsed.success) return;
	const email = parsed.data;
	const [perIp, perEmail] = await Promise.all([
		hit('reset-ip', ip, config().RL_RESET_PER_IP_HOUR, HOUR),
		hit('reset-email', sha256(email), config().RL_RESET_PER_EMAIL_HOUR, HOUR)
	]);
	if (!perIp.ok || !perEmail.ok) return;
	const user = await findUserByEmail(email);
	if (!user || user.status !== 'active') return;
	const token = randomToken();
	await authPool().db.delete(passwordResets).where(eq(passwordResets.userId, user.id));
	await authPool()
		.db.insert(passwordResets)
		.values({ tokenHash: sha256(token), userId: user.id, expiresAt: new Date(now().getTime() + RESET_TTL_MS) });
	await sendMail({
		to: user.email,
		subject: 'Reset your HRMS password',
		text: `Someone asked to reset the password for your HRMS account.\n\nSet a new password within 30 minutes:\n${config().APP_URL}/reset-password/${token}\n\nIf this was not you, ignore this email.`
	});
}

export async function resetPassword(token: string, password: string): Promise<void> {
	const hash = sha256(token);
	const [row] = await authPool()
		.db.select({ userId: passwordResets.userId, email: users.email })
		.from(passwordResets)
		.innerJoin(users, eq(users.id, passwordResets.userId))
		.where(
			and(
				eq(passwordResets.tokenHash, hash),
				isNull(passwordResets.usedAt),
				gt(passwordResets.expiresAt, now()),
				eq(users.status, 'active')
			)
		);
	if (!row) throw new AppError('invalid_token', 'This reset link is invalid or has expired');
	const problem = passwordProblem(password, row.email);
	if (problem) throw new AppError('weak_password', problem);
	const passwordHash = await hashPassword(password);
	const claimed = await authPool().db.transaction(async (tx) => {
		const used = await tx
			.update(passwordResets)
			.set({ usedAt: now() })
			.where(and(eq(passwordResets.tokenHash, hash), isNull(passwordResets.usedAt)))
			.returning({ userId: passwordResets.userId });
		if (used.length !== 1) return false;
		await tx.update(users).set({ passwordHash }).where(eq(users.id, row.userId));
		return true;
	});
	if (!claimed) throw new AppError('invalid_token', 'This reset link is invalid or has expired');
	await revokeUserFeeds(row.userId);
	await deleteUserSessions(row.userId);
}

export async function changePassword(
	userId: string,
	current: string,
	next: string,
	meta: Meta
): Promise<{ token: string; expiresAt: Date }> {
	const user = await userById(userId);
	if (!user || !(await verifyPassword(user.passwordHash, current)))
		throw new AppError('wrong_password', 'Current password is incorrect');
	const problem = passwordProblem(next, user.email);
	if (problem) throw new AppError('weak_password', problem);
	await authPool()
		.db.update(users)
		.set({ passwordHash: await hashPassword(next) })
		.where(eq(users.id, userId));
	await revokeUserFeeds(userId);
	await deleteUserSessions(userId);
	return createSession(userId, meta);
}

export type InvitationView = { tenantSlug: string; tenantName: string; email: string; userExists: boolean };

export async function loadInvitation(token: string): Promise<InvitationView | null> {
	if (!token || token.length > 100) return null;
	const [row] = await authPool()
		.db.select({ tenantSlug: tenants.slug, tenantName: tenants.name, email: invitations.email })
		.from(invitations)
		.innerJoin(tenants, eq(tenants.id, invitations.tenantId))
		.where(
			and(
				eq(invitations.tokenHash, sha256(token)),
				isNull(invitations.acceptedAt),
				isNull(invitations.revokedAt),
				gt(invitations.expiresAt, now()),
				eq(tenants.status, 'active')
			)
		);
	if (!row) return null;
	return { ...row, userExists: !!(await findUserByEmail(row.email)) };
}

export async function acceptInvitation(token: string, userId: string): Promise<void> {
	try {
		await authPool().sql`select auth_accept_invitation(${sha256(token)}, ${userId})`;
	} catch (err) {
		const msg = (err as Error).message;
		if (msg.includes('invitation_email_mismatch'))
			throw new AppError('invitation_email_mismatch', 'This invitation was sent to a different email address', 403);
		if (msg.includes('invitation_invalid'))
			throw new AppError('invitation_invalid', 'This invitation is invalid or has expired', 410);
		throw err;
	}
}

export async function registerFromInvitation(
	token: string,
	input: { name: string; password: string },
	meta: Meta
): Promise<{ token: string; expiresAt: Date; tenantSlug: string }> {
	const inv = await loadInvitation(token);
	if (!inv) throw new AppError('invitation_invalid', 'This invitation is invalid or has expired', 410);
	if (inv.userExists) throw new AppError('email_taken', 'You already have an account; sign in to accept', 409);
	const userId = await createUser({ email: inv.email, name: input.name, password: input.password });
	await acceptInvitation(token, userId).catch(async (err) => {
		await authPool().db.delete(users).where(eq(users.id, userId));
		throw err;
	});
	const s = await createSession(userId, meta);
	return { ...s, tenantSlug: inv.tenantSlug };
}
