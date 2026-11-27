import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { hashPassword } from '../../src/lib/server/auth/password';
import { confirmRecentAuth, loadInvitation, login } from '../../src/lib/server/auth/service';
import { createSession, validateSession } from '../../src/lib/server/auth/session';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { auditLog, memberships, ssoConnections, userIdentities, users } from '../../src/lib/server/db/schema';
import { createInvitation } from '../../src/lib/server/invitations';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import {
	addSsoDomain,
	finishSso,
	loadSso,
	removeSsoDomain,
	saveSsoConnection,
	setSsoState,
	SSO_MAX_DOMAINS,
	SSO_PASSWORD_SENTINEL,
	SSO_STATE_SECONDS,
	ssoForEmail,
	ssoLinks,
	startSso,
	unlinkSso,
	verifySsoDomain,
	type Exchange,
	type TxtResolver
} from '../../src/lib/server/sso';
import { listUserTenants, resolveTenantAccess } from '../../src/lib/server/tenancy/resolve';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let tenant: Tenant;
let other: Tenant;
const who: Record<string, Member> = {};
const PASSWORD = 'correct horse battery staple 42';
const run = randomUUID().slice(0, 8);
const DOMAIN_A = `acme-${run}.example`;
const DOMAIN_B = `bravo-${run}.example`;
const CLIENT_A = `client-a-${run}.apps.googleusercontent.com`;
const CLIENT_B = `client-b-${run}.apps.googleusercontent.com`;
const ENTRA_TID = '1b2c3d4e-0000-4000-8000-0123456789ab';
const sys = (t = tenant) => systemCtx(t.id);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));

async function member(t: Tenant, key: string, roleKeys: string[], email?: string) {
	const u = await createUser(email);
	await ownerPool().sql`update users set password_hash = ${await hashPassword(PASSWORD)} where id = ${u.id}`;
	const id = await withTenant(sys(t), (tx) => addMember(tx, t.id, u.id, roleKeys));
	const { token } = await createSession(u.id, {});
	who[key] = {
		user: { userId: u.id, sessionId: sha256(token), totpEnabled: false, email: u.email },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: await loadAccess(t.id, { id, status: 'active', employeeId: null })
	} as unknown as Member;
	return u;
}

const confirmed = (key: string) => confirmRecentAuth(who[key].user, PASSWORD, '');

const jwt = (claims: Record<string, unknown>) =>
	[{ alg: 'RS256', typ: 'JWT' }, claims, 'sig']
		.map((p) => (typeof p === 'string' ? p : Buffer.from(JSON.stringify(p)).toString('base64url')))
		.join('.');

const googleClaims = (nonce: string, sub: string, email: string, aud = CLIENT_A) => {
	const t = Math.floor(Date.now() / 1000);
	return {
		iss: 'https://accounts.google.com',
		aud,
		sub,
		email,
		email_verified: true,
		name: 'Ada Lovelace',
		iat: t,
		exp: t + 600,
		nonce
	};
};

type Flow = {
	sub?: string;
	email?: string;
	aud?: string;
	claims?: Record<string, unknown>;
	next?: string;
	linkUserId?: string;
	invite?: string;
	bind?: string;
};

async function signIn(t: Tenant, f: Flow = {}) {
	const started = await startSso({
		tenantId: t.id,
		next: f.next ?? `/t/${t.slug}`,
		linkUserId: f.linkUserId,
		invite: f.invite
	});
	const url = new URL(started.url);
	const state = url.searchParams.get('state')!;
	const nonce = url.searchParams.get('nonce')!;
	const seen: { verifier?: string; code?: string } = {};
	const exchange: Exchange = async (_c, authCode, verifier) => {
		seen.verifier = verifier;
		seen.code = authCode;
		return jwt({
			...googleClaims(
				nonce,
				f.sub ?? 'sub-1',
				f.email ?? `ada@${DOMAIN_A}`,
				f.aud ?? (t === other ? CLIENT_B : CLIENT_A)
			),
			...f.claims
		});
	};
	const finish = () =>
		finishSso({ state, code: 'auth-code', bind: f.bind ?? started.bind, meta: { ip: '203.0.113.9' } }, exchange);
	return { url, state, nonce, started, seen, finish };
}

const resolver =
	(domain: string, token: string): TxtResolver =>
	async (d) =>
		d === domain ? [['v=spf1 -all'], ['hrms-sso-verify=', token]] : [];

const domainId = async (t: Tenant, domain: string) =>
	(await withTenant(sys(t), loadSso)).domains.find((d) => d.domain === domain)!.id;

beforeAll(async () => {
	tenant = await createTenant('sso');
	other = await createTenant('ssob');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(sys(other), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	await member(tenant, 'own', ['owner']);
	await member(tenant, 'staff', [], `staff@${DOMAIN_A}`);
	await member(tenant, 'both', [], `both@${DOMAIN_A}`);
	await member(other, 'olga', ['owner']);
	const r = await redisReady();
	await r.del(...Object.values(who).map((m) => rkey('rl', 'reauth', m.user.userId)));
});

afterAll(async () => {
	await closeRedis();
	await closePools();
});

describe('managing company sign-in', () => {
	it('needs sso.manage and a fresh password', async () => {
		const input = { provider: 'google', clientId: CLIENT_A, clientSecret: 'shh-a', entraTenantId: '' };
		expect(await code(saveSsoConnection(who.staff, input))).toBe('forbidden');
		expect(await code(saveSsoConnection(who.own, input))).toBe('reauth_required');
		await confirmed('own');
		expect(await code(saveSsoConnection(who.own, { ...input, clientSecret: '' }))).toBe('invalid');
		expect(await code(saveSsoConnection(who.own, { ...input, provider: 'okta' }))).toBe('invalid');
		expect(await code(saveSsoConnection(who.own, { ...input, clientId: 'has space' }))).toBe('invalid');
		expect(await code(saveSsoConnection(who.own, { ...input, provider: 'entra', entraTenantId: 'nope' }))).toBe(
			'invalid'
		);
		expect(await code(saveSsoConnection(who.own, input))).toBe('ok');
		const [row] = await withTenant(sys(), (tx) => tx.select().from(ssoConnections));
		expect(row.clientSecretEnc).not.toContain('shh-a');
		expect(row.active).toBe(true);
		expect(row.enforce).toBe(false);
		await saveSsoConnection(who.own, { ...input, clientSecret: '' });
		const [kept] = await withTenant(sys(), (tx) => tx.select().from(ssoConnections));
		expect(kept.clientSecretEnc).toBe(row.clientSecretEnc);
		const view = await withTenant(sys(), loadSso);
		expect(JSON.stringify(view)).not.toContain(row.clientSecretEnc);
		expect(view.redirectUri).toMatch(/\/sso\/callback$/);
		const audits = await withTenant(sys(), (tx) => tx.select().from(auditLog).where(eq(auditLog.rowId, row.id)));
		expect(audits.map((a) => a.event)).toContain('sso.save');
		expect(JSON.stringify(audits)).not.toContain('shh-a');
	});

	it('keeps the other organisation out', async () => {
		expect((await withTenant(sys(other), loadSso)).connection).toBeNull();
		await confirmed('olga');
		expect(await code(addSsoDomain(who.olga, 'x.example'))).toBe('invalid');
		const id = await domainId(tenant, DOMAIN_A).catch(() => undefined);
		expect(id).toBeUndefined();
	});

	it('verifies a domain only from its TXT record, and one organisation owns a domain', async () => {
		expect(await code(addSsoDomain(who.own, 'not a domain'))).toBe('invalid');
		expect(await code(addSsoDomain(who.own, `${DOMAIN_A.toUpperCase()}.`))).toBe('ok');
		expect(await code(addSsoDomain(who.own, DOMAIN_A))).toBe('duplicate');
		const { connection } = await withTenant(sys(), loadSso);
		const id = await domainId(tenant, DOMAIN_A);
		expect(await code(setSsoState(who.own, { enforce: true }))).toBe('invalid');
		expect(await code(verifySsoDomain(who.own, id, resolver(DOMAIN_A, 'wrong')))).toBe('not_verified');
		expect(await code(verifySsoDomain(who.own, id, async () => Promise.reject(new Error('NXDOMAIN'))))).toBe(
			'not_verified'
		);
		expect(await code(verifySsoDomain(who.olga, id, resolver(DOMAIN_A, connection!.verifyToken)))).toBe('not_found');
		expect(await verifySsoDomain(who.own, id, resolver(DOMAIN_A, connection!.verifyToken))).toBe(DOMAIN_A);
		expect(await ssoForEmail(`anyone@${DOMAIN_A}`)).toEqual({ tenantId: tenant.id });
		expect(await ssoForEmail(`anyone@sub.${DOMAIN_A}`)).toBeNull();
		expect(await ssoForEmail('not-an-email')).toBeNull();

		await saveSsoConnection(who.olga, {
			provider: 'google',
			clientId: CLIENT_B,
			clientSecret: 'shh-b',
			entraTenantId: ''
		});
		await addSsoDomain(who.olga, DOMAIN_A);
		const olgaToken = (await withTenant(sys(other), loadSso)).connection!.verifyToken;
		const stolen = await domainId(other, DOMAIN_A);
		expect(await code(verifySsoDomain(who.olga, stolen, resolver(DOMAIN_A, olgaToken)))).toBe('duplicate');
		await removeSsoDomain(who.olga, stolen);
		await addSsoDomain(who.olga, DOMAIN_B);
		await verifySsoDomain(who.olga, await domainId(other, DOMAIN_B), resolver(DOMAIN_B, olgaToken));
		expect(await ssoForEmail(`x@${DOMAIN_B}`)).toEqual({ tenantId: other.id });
	});

	it('caps the domain list', async () => {
		const extra = Array.from({ length: SSO_MAX_DOMAINS - 1 }, (_, i) => `cap${i}-${run}.example`);
		for (const d of extra) await addSsoDomain(who.own, d);
		expect(await code(addSsoDomain(who.own, `cap-over-${run}.example`))).toBe('invalid');
		const view = await withTenant(sys(), loadSso);
		await Promise.all(
			view.domains.filter((d) => d.domain.startsWith('cap')).map((d) => removeSsoDomain(who.own, d.id))
		);
		expect((await withTenant(sys(), loadSso)).domains.map((d) => d.domain)).toEqual([DOMAIN_A]);
	});

	it('saves a Microsoft Entra connection with its directory ID', async () => {
		const t = await createTenant('ssoe');
		await withTenant(sys(t), (tx) => seedTenant(tx, t.id, TEST_LOCALE));
		await member(t, 'eve', ['owner']);
		await confirmed('eve');
		await saveSsoConnection(who.eve, {
			provider: 'entra',
			clientId: 'entra-app',
			clientSecret: 's',
			entraTenantId: ENTRA_TID.toUpperCase()
		});
		const { connection } = await withTenant(sys(t), loadSso);
		expect(connection).toMatchObject({ provider: 'entra', entraTenantId: ENTRA_TID });
		const { url } = await startSso({ tenantId: t.id, next: `/t/${t.slug}` });
		expect(url).toContain(`login.microsoftonline.com/${ENTRA_TID}/`);
	});
});

describe('signing in with a company account', () => {
	it('starts with a short lived state that names this provider', async () => {
		expect(await code(startSso({ tenantId: randomUUID(), next: '/' }))).toBe('sso_off');
		const f = await signIn(tenant);
		expect(f.url.origin).toBe('https://accounts.google.com');
		expect(f.url.searchParams.get('client_id')).toBe(CLIENT_A);
		expect(f.url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(f.url.searchParams.get('prompt')).toBe('select_account');
		const r = await redisReady();
		const ttl = await r.ttl(rkey('sso', sha256(f.state)));
		expect(ttl).toBeGreaterThan(SSO_STATE_SECONDS - 10);
		expect(await r.get(rkey('sso', sha256(f.state)))).not.toContain(f.started.bind);
	});

	it('refuses a foreign browser, a replayed state and a bad token', async () => {
		const stranger = await signIn(tenant, { bind: 'someone-else' });
		expect(await code(stranger.finish())).toBe('sso_failed');
		expect(await code(stranger.finish())).toBe('sso_expired');
		expect(await code(finishSso({ state: null, code: 'x', bind: 'y', meta: {} }))).toBe('sso_failed');

		const cases: Flow[] = [
			{ claims: { nonce: 'other-nonce' } },
			{ claims: { iss: 'https://evil.example' } },
			{ aud: CLIENT_B },
			{ claims: { aud: [CLIENT_A, CLIENT_B], azp: CLIENT_B } },
			{ claims: { exp: Math.floor(Date.now() / 1000) - 600 } },
			{ claims: { iat: Math.floor(Date.now() / 1000) + 3600 } },
			{ claims: { email_verified: false } },
			{ claims: { email_verified: 'true' } }
		];
		const results = await Promise.all(cases.map(async (c) => code((await signIn(tenant, c)).finish())));
		expect(results).toEqual(cases.map(() => 'sso_failed'));

		const broken = await signIn(tenant);
		expect(
			await code(finishSso({ state: broken.state, code: 'c', bind: broken.started.bind, meta: {} }, async () => 'x'))
		).toBe('sso_failed');
	});

	it('passes the code verifier from the start of the flow', async () => {
		const f = await signIn(tenant, { sub: 'nobody' });
		await code(f.finish());
		expect(f.seen.code).toBe('auth-code');
		expect(f.seen.verifier).toMatch(/^[A-Za-z0-9_-]{20,}$/);
	});

	it('refuses an email domain that is not verified here', async () => {
		expect(await code((await signIn(tenant, { email: `ada@${DOMAIN_B}` })).finish())).toBe('sso_domain');
		expect(await code((await signIn(tenant, { email: 'ada@gmail.com' })).finish())).toBe('sso_domain');
	});

	it('refuses an account nobody has linked', async () => {
		expect(await code((await signIn(tenant, { sub: 'unlinked', email: `staff@${DOMAIN_A}` })).finish())).toBe(
			'sso_unlinked'
		);
	});

	it('links only for a member, then signs in to a session locked to this organisation', async () => {
		const outsider = await createUser();
		expect(await code((await signIn(tenant, { sub: 'g-staff', linkUserId: outsider.id })).finish())).toBe('no_access');
		const staff = who.staff.user.userId;
		expect(
			await (await signIn(tenant, { sub: 'g-staff', email: `staff@${DOMAIN_A}`, linkUserId: staff })).finish()
		).toEqual({
			kind: 'linked'
		});
		expect(await code((await signIn(tenant, { sub: 'g-staff', linkUserId: who.both.user.userId })).finish())).toBe(
			'already_linked'
		);
		expect(await code((await signIn(tenant, { sub: 'g-other', linkUserId: staff })).finish())).toBe('already_linked');
		const [identity] = await withTenant(sys(), (tx) =>
			tx.select().from(userIdentities).where(eq(userIdentities.userId, staff))
		);
		expect(identity).toMatchObject({ issuer: 'https://accounts.google.com', subject: 'g-staff' });

		const done = await (
			await signIn(tenant, { sub: 'g-staff', email: `staff@${DOMAIN_A}`, next: `/t/${tenant.slug}/leave?x=1` })
		).finish();
		expect(done).toMatchObject({ kind: 'session', next: `/t/${tenant.slug}/leave?x=1` });
		const session = await validateSession(done.kind === 'session' ? done.token : undefined);
		expect(session).toMatchObject({ userId: staff, ssoTenantId: tenant.id });
		const away = await (await signIn(tenant, { sub: 'g-staff', next: `/t/${other.slug}` })).finish();
		expect(away).toMatchObject({ kind: 'session', next: `/t/${tenant.slug}` });
		const sneaky = await (await signIn(tenant, { sub: 'g-staff', next: `/t/${tenant.slug}x/admin` })).finish();
		expect(sneaky).toMatchObject({ next: `/t/${tenant.slug}` });
	});

	it('matches by the provider subject, not by the email', async () => {
		const swapped = await signIn(tenant, { sub: 'g-staff', email: `both@${DOMAIN_A}` });
		const res = await swapped.finish();
		expect(await validateSession(res.kind === 'session' ? res.token : undefined)).toMatchObject({
			userId: who.staff.user.userId
		});
		expect(await code((await signIn(tenant, { sub: 'g-both', email: `staff@${DOMAIN_A}` })).finish())).toBe(
			'sso_unlinked'
		);
	});

	it('never lets another organisation sign in a person linked only here', async () => {
		const both = who.both.user.userId;
		await withTenant(sys(other), (tx) => addMember(tx, other.id, both, []));
		await signIn(tenant, { sub: 'g-both', email: `both@${DOMAIN_A}`, linkUserId: both }).then((f) => f.finish());
		expect(await code((await signIn(other, { sub: 'g-both', email: `both@${DOMAIN_A}` })).finish())).toBe('sso_domain');
		expect(await code((await signIn(other, { sub: 'g-both', email: `both@${DOMAIN_B}` })).finish())).toBe(
			'sso_unlinked'
		);
		const res = await (await signIn(tenant, { sub: 'g-both', email: `both@${DOMAIN_A}` })).finish();
		const session = await validateSession(res.kind === 'session' ? res.token : undefined);
		expect((await listUserTenants(both, session!.ssoTenantId)).map((t) => t.slug)).toEqual([tenant.slug]);
		expect((await listUserTenants(both)).map((t) => t.slug).sort()).toEqual([tenant.slug, other.slug].sort());
	});

	it('refuses a removed member and a switched off connection', async () => {
		const u = await member(tenant, 'gone', [], `gone@${DOMAIN_A}`);
		await signIn(tenant, { sub: 'g-gone', email: u.email, linkUserId: u.id }).then((f) => f.finish());
		await withTenant(sys(), (tx) =>
			tx.update(memberships).set({ status: 'disabled' }).where(eq(memberships.userId, u.id))
		);
		expect(await code((await signIn(tenant, { sub: 'g-gone', email: u.email })).finish())).toBe('no_access');

		const pending = await signIn(tenant, { sub: 'g-staff', email: `staff@${DOMAIN_A}` });
		await setSsoState(who.own, { active: false });
		expect(await code(pending.finish())).toBe('sso_off');
		expect(await ssoForEmail(`staff@${DOMAIN_A}`)).toBeNull();
		expect(await code(startSso({ tenantId: tenant.id, next: '/' }))).toBe('sso_off');
		await setSsoState(who.own, { active: true });
	});
});

describe('accepting an invitation with a company account', () => {
	const invite = (email: string) =>
		withTenant(sys(), (tx) => createInvitation(tx, { tenantId: tenant.id, email, roleIds: [] })).then((i) => i.token);

	it('creates a person without a password and links them', async () => {
		const email = `new-${run}@${DOMAIN_A}`;
		const token = await invite(email);
		expect((await loadInvitation(token))?.tenantId).toBe(tenant.id);
		expect(
			await code((await signIn(tenant, { sub: 'g-new', email: `other-${run}@${DOMAIN_A}`, invite: token })).finish())
		).toBe('invitation_email_mismatch');
		expect(
			await code((await signIn(other, { sub: 'g-new', email: `new-${run}@${DOMAIN_B}`, invite: token })).finish())
		).toBe('invitation_invalid');
		const res = await (await signIn(tenant, { sub: 'g-new', email, invite: token })).finish();
		expect(res.kind).toBe('session');
		const [u] = await ownerPool().db.select().from(users).where(eq(users.email, email));
		expect(u.passwordHash).toBe(SSO_PASSWORD_SENTINEL);
		expect(u.name).toBe('Ada Lovelace');
		expect((await login({ email, password: SSO_PASSWORD_SENTINEL, meta: { ip: '203.0.113.9' } })).kind).toBe('invalid');
		const [m] = await withTenant(sys(), (tx) => tx.select().from(memberships).where(eq(memberships.userId, u.id)));
		expect(m.status).toBe('active');
		expect(await loadInvitation(token)).toBeNull();
		expect(await code((await signIn(tenant, { sub: 'g-new2', email, invite: token })).finish())).toBe(
			'invitation_invalid'
		);
	});

	it('sends an existing person back to their password', async () => {
		const token = await invite(`staff@${DOMAIN_A}`.replace('staff', 'both'));
		expect(
			await code((await signIn(tenant, { sub: 'g-both-2', email: `both@${DOMAIN_A}`, invite: token })).finish())
		).toBe('sso_taken');
	});
});

describe('requiring company sign-in', () => {
	it('flags the organisation only while on with a verified domain', async () => {
		const own = who.own.user.userId;
		expect(await code(setSsoState(who.own, { enforce: true }))).toBe('totp_required');
		(who.own.user as { totpEnabled: boolean }).totpEnabled = true;
		expect((await resolveTenantAccess(tenant.slug, own))?.tenant.ssoEnforced).toBe(false);
		await setSsoState(who.own, { enforce: true });
		expect((await resolveTenantAccess(tenant.slug, own))?.tenant.ssoEnforced).toBe(true);
		expect((await resolveTenantAccess(other.slug, who.olga.user.userId))?.tenant.ssoEnforced).toBe(false);
		await setSsoState(who.own, { active: false });
		const [row] = await withTenant(sys(), (tx) => tx.select().from(ssoConnections));
		expect(row).toMatchObject({ active: false, enforce: false });
		await setSsoState(who.own, { active: true });
		await setSsoState(who.own, { enforce: true });
		await removeSsoDomain(who.own, await domainId(tenant, DOMAIN_A));
		expect((await resolveTenantAccess(tenant.slug, own))?.tenant.ssoEnforced).toBe(false);
		const { connection } = await withTenant(sys(), loadSso);
		await addSsoDomain(who.own, DOMAIN_A);
		await verifySsoDomain(who.own, await domainId(tenant, DOMAIN_A), resolver(DOMAIN_A, connection!.verifyToken));
	});
});

describe('account links', () => {
	it('lists and unlinks only the person’s own link', async () => {
		const staff = who.staff.user.userId;
		expect(await ssoLinks(staff)).toEqual([expect.objectContaining({ tenantId: tenant.id, linked: true })]);
		expect(await code(unlinkSso(staff, other.id))).toBe('not_found');
		expect(await code(unlinkSso(staff, 'nope'))).toBe('not_found');
		await unlinkSso(staff, tenant.id);
		expect(await ssoLinks(staff)).toEqual([expect.objectContaining({ linked: false })]);
		expect(await code(unlinkSso(staff, tenant.id))).toBe('not_found');
		const left = await withTenant(sys(), (tx) => tx.select().from(userIdentities));
		expect(left.some((i) => i.userId === who.both.user.userId)).toBe(true);
		expect(await code((await signIn(tenant, { sub: 'g-staff', email: `staff@${DOMAIN_A}` })).finish())).toBe(
			'sso_unlinked'
		);
	});
});

describe('ending company sign-in sessions', () => {
	it('signs out a person when they unlink and everyone when the connection is turned off', async () => {
		const both = who.both.user.userId;
		const staff = who.staff.user.userId;
		await signIn(tenant, { sub: 'g-staff', email: `staff@${DOMAIN_A}`, linkUserId: staff }).then((f) => f.finish());
		const token = async (sub: string, email: string) => {
			const r = await (await signIn(tenant, { sub, email })).finish();
			return r.kind === 'session' ? r.token : undefined;
		};
		const bothToken = await token('g-both', `both@${DOMAIN_A}`);
		const staffToken = await token('g-staff', `staff@${DOMAIN_A}`);
		const { token: passwordToken } = await createSession(both, {});
		await unlinkSso(both, tenant.id);
		expect(await validateSession(bothToken)).toBeNull();
		expect(await validateSession(passwordToken)).toMatchObject({ userId: both, ssoTenantId: null });
		expect(await validateSession(staffToken)).toMatchObject({ userId: staff });
		await setSsoState(who.own, { active: false });
		expect(await validateSession(staffToken)).toBeNull();
		expect(await validateSession(passwordToken)).not.toBeNull();
		await setSsoState(who.own, { active: true });
	});

	it('keeps the client secret away from the sign-in database role', async () => {
		const [row] = await ownerPool().sql<{ secret: boolean; token: boolean; enforce: boolean }[]>`
			select has_column_privilege('hrms_auth', 'public.sso_connections', 'client_secret_enc', 'select') as secret,
				has_column_privilege('hrms_auth', 'public.sso_connections', 'verify_token', 'select') as token,
				has_column_privilege('hrms_auth', 'public.sso_connections', 'enforce', 'select') as enforce`;
		expect(row).toEqual({ secret: false, token: false, enforce: true });
	});
});
