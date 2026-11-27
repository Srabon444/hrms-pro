import { resolveTxt } from 'node:dns/promises';
import { decodeIdToken, Google, MicrosoftEntraId } from 'arctic';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { API_REAUTH_MINUTES } from './api-keys';
import { auditEvent } from './audit';
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from './auth/crypto';
import { acceptInvitation, loadInvitation } from './auth/service';
import { createSession, deleteSsoSessions, requireRecentAuth } from './auth/session';
import { emailSchema, findUserByEmail } from './auth/users';
import { now } from './clock';
import { config } from './config';
import { authPool } from './db';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { memberships, ssoConnections, ssoDomains, SSO_PROVIDERS, tenants, userIdentities, users } from './db/schema';
import { AppError } from './errors';
import { lookupToken } from './public/tokens';
import { can, userCtx, type requireMember } from './rbac/access';
import { redisReady, rkey } from './redis';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Meta = { ip?: string | null; userAgent?: string | null };

export const SSO_STATE_SECONDS = 600;
export const SSO_MAX_DOMAINS = 10;
export const SSO_COOKIE = 'hrms_sso';
export const SSO_PASSWORD_SENTINEL = '!sso';
export const SSO_ORIGINS = ['https://accounts.google.com', 'https://login.microsoftonline.com'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CLOCK_SKEW_S = 120;

export const SSO_MESSAGES: Record<string, string> = {
	sso_failed: 'Sign-in with your company account did not finish. Try again.',
	sso_expired: 'That sign-in took too long. Start again.',
	sso_cancelled: 'Sign-in was cancelled.',
	sso_off: 'Company sign-in is not set up for this organisation.',
	sso_domain: 'That account’s email domain is not set up for sign-in here.',
	sso_unlinked:
		'This company account is not linked yet. Sign in with your password once, then link it under Account → Security.',
	sso_taken:
		'You already have an account. Sign in with your password to accept the invitation, then link company sign-in under Account → Security.',
	no_access: 'You do not have access to this organisation.',
	unavailable: 'Company sign-in is unavailable right now. Try again in a minute.',
	invitation_invalid: 'This invitation is invalid, already used or expired.',
	invitation_email_mismatch: 'This invitation was sent to a different email address.'
};

export const ssoMessage = (code: string | null) =>
	code ? (Object.hasOwn(SSO_MESSAGES, code) ? SSO_MESSAGES[code] : SSO_MESSAGES.sso_failed) : null;

const fail = (code: keyof typeof SSO_MESSAGES, status = 400) => new AppError(code, SSO_MESSAGES[code], status);

const manager = async (m: Member) => {
	if (!can(m.access, 'sso.manage')) throw new AppError('forbidden', 'Only the owner can change company sign-in.', 403);
	await requireRecentAuth(m.user.sessionId, API_REAUTH_MINUTES);
};

const aad = (tenantId: string, id: string) => `sso:${tenantId}:${id}`;
export const redirectUri = () => new URL('/sso/callback', config().APP_URL).toString();
const issuerOf = (c: { provider: string; entraTenantId: string | null }) =>
	c.provider === 'google' ? 'https://accounts.google.com' : `https://login.microsoftonline.com/${c.entraTenantId}/v2.0`;

export async function loadSso(tx: Tx) {
	const [connection] = await tx
		.select({
			id: ssoConnections.id,
			provider: ssoConnections.provider,
			clientId: ssoConnections.clientId,
			entraTenantId: ssoConnections.entraTenantId,
			verifyToken: ssoConnections.verifyToken,
			active: ssoConnections.active,
			enforce: ssoConnections.enforce
		})
		.from(ssoConnections);
	const domains = connection
		? await tx
				.select({ id: ssoDomains.id, domain: ssoDomains.domain, verifiedAt: ssoDomains.verifiedAt })
				.from(ssoDomains)
				.orderBy(asc(ssoDomains.domain))
		: [];
	const [{ linked }] = await tx.select({ linked: sql<number>`count(*)::int` }).from(userIdentities);
	return { connection: connection ?? null, domains, linked, redirectUri: redirectUri() };
}

const connectionSchema = z.object({
	provider: z.enum(SSO_PROVIDERS, 'Pick Google Workspace or Microsoft Entra.'),
	clientId: z
		.string()
		.trim()
		.min(1, 'Enter the client ID.')
		.max(200, 'The client ID is too long.')
		.regex(/^[\x21-\x7e]+$/, 'The client ID has spaces or unusual characters.'),
	clientSecret: z.string().trim().max(500, 'The client secret is too long.'),
	entraTenantId: z.string().trim().toLowerCase()
});

export async function saveSsoConnection(m: Member, raw: Record<string, string>) {
	await manager(m);
	const input = connectionSchema.parse({
		provider: raw.provider ?? '',
		clientId: raw.clientId ?? '',
		clientSecret: raw.clientSecret ?? '',
		entraTenantId: raw.entraTenantId ?? ''
	});
	if (input.provider === 'entra' && !GUID.test(input.entraTenantId))
		throw new AppError('invalid', 'Enter the Directory (tenant) ID, like 1b2c3d4e-0000-4000-8000-0123456789ab.', 400);
	const entraTenantId = input.provider === 'entra' ? input.entraTenantId : null;
	await withTenant(userCtx(m), async (tx) => {
		const [existing] = await tx.select({ id: ssoConnections.id }).from(ssoConnections).for('update');
		if (!existing && !input.clientSecret) throw new AppError('invalid', 'Enter the client secret.', 400);
		const id = existing?.id ?? crypto.randomUUID();
		const secret = input.clientSecret
			? { clientSecretEnc: encrypt(input.clientSecret, undefined, aad(m.tenant.id, id)) }
			: {};
		if (existing)
			await tx
				.update(ssoConnections)
				.set({ provider: input.provider, clientId: input.clientId, entraTenantId, ...secret })
				.where(eq(ssoConnections.id, id));
		else
			await tx.insert(ssoConnections).values({
				id,
				tenantId: m.tenant.id,
				provider: input.provider,
				clientId: input.clientId,
				entraTenantId,
				clientSecretEnc: secret.clientSecretEnc!,
				verifyToken: randomToken(18)
			});
		await auditEvent(tx, userCtx(m), 'sso_connections', id, 'sso.save', { provider: input.provider });
	});
}

const domainSchema = z
	.string()
	.trim()
	.toLowerCase()
	.transform((v) => v.replace(/\.$/, ''))
	.pipe(z.string().max(253, 'That domain is too long.').regex(DOMAIN, 'Enter a domain like example.com.'));

export async function addSsoDomain(m: Member, raw: string) {
	await manager(m);
	const domain = domainSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const [c] = await tx.select({ id: ssoConnections.id }).from(ssoConnections).for('update');
		if (!c) throw new AppError('invalid', 'Save the connection first.', 400);
		const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(ssoDomains);
		if (n >= SSO_MAX_DOMAINS) throw new AppError('invalid', `Add at most ${SSO_MAX_DOMAINS} domains.`, 400);
		await tx
			.insert(ssoDomains)
			.values({ tenantId: m.tenant.id, connectionId: c.id, domain })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION) throw new AppError('duplicate', 'That domain is already listed.', 409);
				throw err;
			});
	});
}

export type TxtResolver = (domain: string) => Promise<string[][]>;

export async function verifySsoDomain(m: Member, rawId: string, resolve: TxtResolver = resolveTxt) {
	await manager(m);
	const id = z.uuid().safeParse(rawId);
	if (!id.success) throw new AppError('not_found', 'That domain is not listed.', 404);
	const [row] = await withTenant(userCtx(m), (tx) =>
		tx
			.select({ domain: ssoDomains.domain, token: ssoConnections.verifyToken })
			.from(ssoDomains)
			.innerJoin(ssoConnections, eq(ssoConnections.id, ssoDomains.connectionId))
			.where(eq(ssoDomains.id, id.data))
	);
	if (!row) throw new AppError('not_found', 'That domain is not listed.', 404);
	const records = await resolve(row.domain).catch(() => [] as string[][]);
	if (!records.some((r) => r.join('') === `hrms-sso-verify=${row.token}`))
		throw new AppError(
			'not_verified',
			`We could not find the TXT record on ${row.domain} yet. DNS changes can take up to an hour.`,
			400
		);
	await withTenant(userCtx(m), (tx) =>
		tx
			.update(ssoDomains)
			.set({ verifiedAt: now() })
			.where(eq(ssoDomains.id, id.data))
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('duplicate', 'Another organisation already uses this domain for sign-in.', 409);
				throw err;
			})
	);
	return row.domain;
}

export async function removeSsoDomain(m: Member, rawId: string) {
	await manager(m);
	const id = z.uuid().safeParse(rawId);
	if (!id.success) throw new AppError('not_found', 'That domain is not listed.', 404);
	await withTenant(userCtx(m), async (tx) => {
		const gone = await tx.delete(ssoDomains).where(eq(ssoDomains.id, id.data)).returning({ id: ssoDomains.id });
		if (!gone.length) throw new AppError('not_found', 'That domain is not listed.', 404);
		const [left] = await tx
			.select({ id: ssoDomains.id })
			.from(ssoDomains)
			.where(isNotNull(ssoDomains.verifiedAt))
			.limit(1);
		if (!left) await tx.update(ssoConnections).set({ enforce: false });
	});
}

export async function setSsoState(m: Member, change: { active?: boolean; enforce?: boolean }) {
	await manager(m);
	await withTenant(userCtx(m), async (tx) => {
		const [c] = await tx
			.select({ id: ssoConnections.id, active: ssoConnections.active })
			.from(ssoConnections)
			.for('update');
		if (!c) throw new AppError('invalid', 'Save the connection first.', 400);
		const active = change.active ?? c.active;
		if (change.enforce) {
			const [verified] = await tx
				.select({ id: ssoDomains.id })
				.from(ssoDomains)
				.where(isNotNull(ssoDomains.verifiedAt))
				.limit(1);
			if (!active || !verified)
				throw new AppError('invalid', 'Turn company sign-in on and verify a domain before requiring it.', 400);
			if (!m.user.totpEnabled)
				throw new AppError(
					'totp_required',
					'Turn on two-factor sign-in for your own account first. Owners with two-factor sign-in keep password sign-in as the way back in.',
					400
				);
		}
		const enforce = active ? (change.enforce ?? undefined) : false;
		await tx
			.update(ssoConnections)
			.set({ active, ...(enforce === undefined ? {} : { enforce }) })
			.where(eq(ssoConnections.id, c.id));
		await auditEvent(tx, userCtx(m), 'sso_connections', c.id, 'sso.state', {
			active: String(active),
			...(enforce === undefined ? {} : { enforce: String(enforce) })
		});
	});
	if (change.active === false) await deleteSsoSessions(m.tenant.id);
}

export async function ssoForEmail(rawEmail: string) {
	const email = emailSchema.safeParse(rawEmail);
	if (!email.success) return null;
	const found = await lookupToken('sso_domain', email.data.split('@')[1]);
	return found ? { tenantId: found.tenantId } : null;
}

type Connection = {
	id: string;
	tenantId: string;
	provider: string;
	clientId: string;
	clientSecretEnc: string;
	entraTenantId: string | null;
};

const activeConnection = async (tenantId: string) => {
	const [c] = await withTenant(systemCtx(tenantId), (tx) =>
		tx
			.select({
				id: ssoConnections.id,
				tenantId: ssoConnections.tenantId,
				provider: ssoConnections.provider,
				clientId: ssoConnections.clientId,
				clientSecretEnc: ssoConnections.clientSecretEnc,
				entraTenantId: ssoConnections.entraTenantId
			})
			.from(ssoConnections)
			.where(eq(ssoConnections.active, true))
	);
	return (c as Connection | undefined) ?? null;
};

const client = (c: Connection) => {
	const secret = decrypt(c.clientSecretEnc, undefined, aad(c.tenantId, c.id));
	return c.provider === 'google'
		? new Google(c.clientId, secret, redirectUri())
		: new MicrosoftEntraId(c.entraTenantId!, c.clientId, secret, redirectUri());
};

type Pending = {
	tenantId: string;
	connectionId: string;
	verifier: string;
	nonce: string;
	bind: string;
	next: string;
	linkUserId: string | null;
	invite: string | null;
};

const stateKey = (state: string) => rkey('sso', sha256(state));

async function redis() {
	try {
		return await redisReady();
	} catch {
		throw fail('unavailable', 503);
	}
}

export async function startSso(input: {
	tenantId: string;
	next: string;
	linkUserId?: string | null;
	invite?: string | null;
}): Promise<{ url: string; bind: string }> {
	const c = await activeConnection(input.tenantId);
	if (!c) throw fail('sso_off', 404);
	const state = randomToken();
	const verifier = randomToken();
	const nonce = randomToken();
	const bind = randomToken();
	const pending: Pending = {
		tenantId: c.tenantId,
		connectionId: c.id,
		verifier,
		nonce,
		bind: sha256(bind),
		next: input.next,
		linkUserId: input.linkUserId ?? null,
		invite: input.invite ?? null
	};
	await (await redis()).set(stateKey(state), JSON.stringify(pending), 'EX', SSO_STATE_SECONDS);
	const url = client(c).createAuthorizationURL(state, verifier, ['openid', 'email', 'profile']);
	url.searchParams.set('nonce', nonce);
	if (c.provider === 'google') url.searchParams.set('prompt', 'select_account');
	return { url: url.toString(), bind };
}

export type Exchange = (c: Connection, code: string, verifier: string) => Promise<string>;
const exchangeCode: Exchange = async (c, code, verifier) =>
	(await client(c).validateAuthorizationCode(code, verifier)).idToken();

type Claims = { issuer: string; subject: string; email: string; name: string };

export function checkIdToken(
	c: Pick<Connection, 'provider' | 'clientId' | 'entraTenantId'>,
	idToken: string,
	nonce: string
): Claims {
	let claims: Record<string, unknown>;
	try {
		claims = decodeIdToken(idToken) as Record<string, unknown>;
	} catch {
		throw fail('sso_failed');
	}
	const t = Math.floor(now().getTime() / 1000);
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	const issuer = issuerOf(c);
	const issOk = claims.iss === issuer || (c.provider === 'google' && claims.iss === 'accounts.google.com');
	if (
		!issOk ||
		!aud.includes(c.clientId) ||
		(aud.length > 1 && claims.azp !== c.clientId) ||
		typeof claims.exp !== 'number' ||
		claims.exp + CLOCK_SKEW_S <= t ||
		(typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > t) ||
		typeof claims.nonce !== 'string' ||
		!safeEqual(claims.nonce, nonce)
	)
		throw fail('sso_failed');
	const subject =
		c.provider === 'google'
			? typeof claims.sub === 'string' && claims.email_verified === true
				? claims.sub
				: null
			: claims.tid === c.entraTenantId && typeof claims.oid === 'string'
				? `${claims.tid}:${claims.oid}`
				: null;
	const email = emailSchema.safeParse(
		c.provider === 'google' ? claims.email : (claims.email ?? claims.preferred_username)
	);
	if (!subject || !email.success) throw fail('sso_failed');
	const name =
		typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 120) : email.data.split('@')[0];
	return { issuer, subject, email: email.data, name };
}

export type SsoResult = { kind: 'session'; token: string; expiresAt: Date; next: string } | { kind: 'linked' };

const tenantSlug = async (tenantId: string) => {
	const [t] = await authPool()
		.db.select({ slug: tenants.slug })
		.from(tenants)
		.where(and(eq(tenants.id, tenantId), eq(tenants.status, 'active')));
	return t?.slug ?? null;
};

const activeMember = async (tenantId: string, userId: string) => {
	const [row] = await authPool()
		.db.select({ id: memberships.id })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.where(
			and(
				eq(memberships.tenantId, tenantId),
				eq(memberships.userId, userId),
				eq(memberships.status, 'active'),
				eq(users.status, 'active')
			)
		);
	return !!row;
};

export async function finishSso(
	input: { state: string | null; code: string | null; bind: string | undefined; meta: Meta },
	exchange: Exchange = exchangeCode
): Promise<SsoResult> {
	if (!input.state || !input.code || input.state.length > 100 || input.code.length > 2000) throw fail('sso_failed');
	const raw = await (await redis()).getdel(stateKey(input.state));
	if (!raw) throw fail('sso_expired');
	const p = JSON.parse(raw) as Pending;
	if (!input.bind || !safeEqual(sha256(input.bind), p.bind)) throw fail('sso_failed');
	const c = await activeConnection(p.tenantId);
	if (!c || c.id !== p.connectionId) throw fail('sso_off', 404);
	const idToken = await exchange(c, input.code, p.verifier).catch(() => {
		throw fail('sso_failed');
	});
	const claims = checkIdToken(c, idToken, p.nonce);
	const slug = await tenantSlug(p.tenantId);
	if (!slug) throw fail('no_access', 403);
	const ctx = systemCtx(p.tenantId);
	const { linked, verified } = await withTenant(ctx, async (tx) => {
		const [identity] = await tx
			.select({ userId: userIdentities.userId })
			.from(userIdentities)
			.where(
				and(
					eq(userIdentities.connectionId, c.id),
					eq(userIdentities.issuer, claims.issuer),
					eq(userIdentities.subject, claims.subject)
				)
			);
		const [domain] = await tx
			.select({ id: ssoDomains.id })
			.from(ssoDomains)
			.where(and(eq(ssoDomains.domain, claims.email.split('@')[1]), isNotNull(ssoDomains.verifiedAt)));
		return { linked: identity?.userId ?? null, verified: !!domain };
	});
	if (!verified) throw fail('sso_domain', 403);
	const link = (tx: Tx, userId: string) =>
		tx
			.insert(userIdentities)
			.values({
				tenantId: p.tenantId,
				connectionId: c.id,
				userId,
				issuer: claims.issuer,
				subject: claims.subject,
				email: claims.email
			})
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError(
						'already_linked',
						'Your account is already linked to a different company account here. Unlink it first.',
						409
					);
				throw err;
			});
	let userId = linked;
	if (p.linkUserId) {
		if (linked && linked !== p.linkUserId)
			throw new AppError('already_linked', 'That company account is linked to someone else.', 409);
		if (!(await activeMember(p.tenantId, p.linkUserId))) throw fail('no_access', 403);
		if (!linked)
			await withTenant(ctx, async (tx) => {
				await link(tx, p.linkUserId!);
				await auditEvent(tx, { ...ctx, userId: p.linkUserId!, actor: 'user' }, 'user_identities', null, 'sso.link', {
					email: claims.email
				});
			});
		return { kind: 'linked' };
	}
	if (!userId && p.invite) {
		const inv = await loadInvitation(p.invite);
		if (!inv || inv.tenantSlug !== slug) throw fail('invitation_invalid', 410);
		if (inv.email.toLowerCase() !== claims.email) throw fail('invitation_email_mismatch', 403);
		if (await findUserByEmail(claims.email)) throw fail('sso_taken', 409);
		const [created] = await authPool()
			.db.insert(users)
			.values({ email: claims.email, name: claims.name, passwordHash: SSO_PASSWORD_SENTINEL })
			.onConflictDoNothing({ target: users.email })
			.returning({ id: users.id });
		if (!created) throw fail('sso_taken', 409);
		try {
			await acceptInvitation(p.invite, created.id);
			await withTenant(ctx, (tx) => link(tx, created.id));
		} catch (err) {
			await authPool().db.delete(users).where(eq(users.id, created.id));
			throw err;
		}
		userId = created.id;
	}
	if (!userId) throw fail('sso_unlinked', 403);
	if (!(await activeMember(p.tenantId, userId))) throw fail('no_access', 403);
	const s = await createSession(userId, input.meta, p.tenantId);
	const home = `/t/${slug}`;
	const next = p.next === home || p.next.startsWith(`${home}/`) || p.next.startsWith(`${home}?`) ? p.next : home;
	return { kind: 'session', ...s, next };
}

export async function ssoLinks(userId: string) {
	const rows = await authPool()
		.db.select({
			tenantId: tenants.id,
			name: tenants.name,
			provider: ssoConnections.provider,
			linked: sql<boolean>`exists (select 1 from ${userIdentities} i where i.tenant_id = ${tenants.id} and i.user_id = ${userId})`
		})
		.from(memberships)
		.innerJoin(tenants, eq(tenants.id, memberships.tenantId))
		.innerJoin(ssoConnections, and(eq(ssoConnections.tenantId, tenants.id), eq(ssoConnections.active, true)))
		.where(and(eq(memberships.userId, userId), eq(memberships.status, 'active'), eq(tenants.status, 'active')))
		.orderBy(asc(tenants.name));
	return rows;
}

export async function unlinkSso(userId: string, rawTenantId: string) {
	const tenantId = z.uuid().safeParse(rawTenantId);
	if (!tenantId.success) throw new AppError('not_found', 'Nothing is linked there.', 404);
	const ctx = { ...systemCtx(tenantId.data), userId, actor: 'user' as const };
	await withTenant(ctx, async (tx) => {
		const gone = await tx
			.delete(userIdentities)
			.where(eq(userIdentities.userId, userId))
			.returning({ id: userIdentities.id });
		if (!gone.length) throw new AppError('not_found', 'Nothing is linked there.', 404);
		await auditEvent(tx, ctx, 'user_identities', gone[0].id, 'sso.unlink');
	});
	await deleteSsoSessions(tenantId.data, userId);
}
