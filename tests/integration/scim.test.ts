import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { hashPassword } from '../../src/lib/server/auth/password';
import { confirmRecentAuth } from '../../src/lib/server/auth/service';
import { createSession, validateSession } from '../../src/lib/server/auth/session';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { auditLog, memberships, users } from '../../src/lib/server/db/schema';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { scimRequest } from '../../src/lib/server/public/scim';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { setMemberStatus, toActor } from '../../src/lib/server/rbac/members';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import {
	addSsoDomain,
	createScimToken,
	loadSso,
	revokeScimToken,
	saveSsoConnection,
	verifySsoDomain
} from '../../src/lib/server/sso';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
type Body = Record<string, unknown> & { Resources?: Record<string, unknown>[] };
let tenant: Tenant;
let other: Tenant;
const who: Record<string, Member> = {};
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const PASSWORD = 'correct horse battery staple 42';
const run = randomUUID().slice(0, 8);
const DOMAIN_A = `scim-a-${run}.example`;
const DOMAIN_B = `scim-b-${run}.example`;
const IP = '203.0.113.71';
const sys = (t = tenant) => systemCtx(t.id);
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

async function member(t: Tenant, key: string, roleKeys: string[], email?: string) {
	const u = await createUser(email);
	await ownerPool().sql`update users set password_hash = ${await hashPassword(PASSWORD)} where id = ${u.id}`;
	const id = await withTenant(sys(t), (tx) => addMember(tx, t.id, u.id, roleKeys));
	const { token } = await createSession(u.id, {});
	ids[key] = id;
	who[key] = {
		user: { userId: u.id, sessionId: sha256(token), totpEnabled: false, email: u.email },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: await loadAccess(t.id, { id, status: 'active', employeeId: null })
	} as unknown as Member;
	return u;
}

async function scim(token: string, method: string, path: string, body?: unknown, ip = IP) {
	const res = await scimRequest(
		new Request(`http://localhost/api/scim/v2/${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
			body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
		}),
		path.split('?')[0],
		ip
	);
	const text = await res.text();
	return { status: res.status, type: res.headers.get('content-type'), body: (text ? JSON.parse(text) : null) as Body };
}

const statusOf = async (id: string, t = tenant) =>
	(
		await withTenant(sys(t), (tx) =>
			tx
				.select({ status: memberships.status, by: memberships.disabledBy })
				.from(memberships)
				.where(eq(memberships.id, id))
		)
	)[0];

const deactivate = (token: string, id: string) =>
	scim(token, 'PATCH', `Users/${id}`, {
		schemas: [PATCH],
		Operations: [{ op: 'Replace', value: { active: 'False' } }]
	});

const activate = (token: string, id: string) =>
	scim(token, 'PATCH', `Users/${id}`, {
		schemas: [PATCH],
		Operations: [{ op: 'replace', path: 'active', value: true }]
	});

async function connect(t: Tenant, owner: string, domain: string) {
	await confirmRecentAuth(who[owner].user, PASSWORD, '');
	await saveSsoConnection(who[owner], {
		provider: 'google',
		clientId: `client-${owner}-${run}.apps.googleusercontent.com`,
		clientSecret: 'shh'
	});
	await addSsoDomain(who[owner], domain);
	const sso = await withTenant(sys(t), loadSso);
	const d = sso.domains.find((x) => x.domain === domain)!;
	await verifySsoDomain(who[owner], d.id, async (q) =>
		q === domain ? [[`hrms-sso-verify=${sso.connection!.verifyToken}`]] : []
	);
	tokens[owner] = await createScimToken(who[owner]);
}

beforeAll(async () => {
	tenant = await createTenant('scim');
	other = await createTenant('scimb');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(sys(other), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	await member(tenant, 'own', ['owner'], `own@${DOMAIN_A}`);
	await member(tenant, 'staff', [], `staff@${DOMAIN_A}`);
	await member(tenant, 'held', [], `held@${DOMAIN_A}`);
	await member(tenant, 'gone', [], `gone@${DOMAIN_A}`);
	await member(other, 'olga', ['owner'], `olga@${DOMAIN_B}`);
	const r = await redisReady();
	await r.del(rkey('rl', 'scim-auth-fail', IP), ...Object.values(who).map((m) => rkey('rl', 'reauth', m.user.userId)));
	await connect(tenant, 'own', DOMAIN_A);
	await connect(other, 'olga', DOMAIN_B);
});

afterAll(async () => {
	await closeRedis();
	await closePools();
});

describe('SCIM provisioning', () => {
	it('needs a live token and answers in SCIM JSON', async () => {
		expect(tokens.own).toMatch(/^hrs_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
		const ok = await scim(tokens.own, 'GET', 'ServiceProviderConfig');
		expect(ok.status).toBe(200);
		expect(ok.type).toContain('application/scim+json');
		expect((ok.body.patch as { supported: boolean }).supported).toBe(true);
		expect((await scim('', 'GET', 'Users')).status).toBe(401);
		expect((await scim('hrs_00000000_' + 'a'.repeat(43), 'GET', 'Users')).status).toBe(401);
		const bad = await scim(tokens.own.slice(0, -1) + 'x', 'GET', 'Users');
		expect(bad.status).toBe(401);
		expect(bad.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
		expect((await scim(tokens.own, 'GET', 'Groups')).status).toBe(404);
		const lower = await scimRequest(
			new Request('http://localhost/api/scim/v2/Users', { headers: { authorization: `bearer ${tokens.own}` } }),
			'Users',
			IP
		);
		expect(lower.status).toBe(200);
	});

	it('lists and filters this organisation only, without names', async () => {
		const all = await scim(tokens.own, 'GET', 'Users?count=2');
		expect(all.status).toBe(200);
		expect(all.body.totalResults).toBe(4);
		expect(all.body.itemsPerPage).toBe(2);
		const last = await scim(tokens.own, 'GET', 'Users?startIndex=4&count=10');
		expect([last.body.totalResults, last.body.startIndex, last.body.itemsPerPage]).toEqual([4, 4, 1]);
		const hit = await scim(tokens.own, 'GET', `Users?filter=${encodeURIComponent(`userName eq "STAFF@${DOMAIN_A}"`)}`);
		expect(hit.body.totalResults).toBe(1);
		const staff = hit.body.Resources![0];
		expect(staff).toMatchObject({ id: ids.staff, userName: `staff@${DOMAIN_A}`, active: true });
		expect(Object.keys(staff).sort()).toEqual(['active', 'emails', 'id', 'meta', 'schemas', 'userName']);
		const miss = await scim(tokens.own, 'GET', `Users?filter=${encodeURIComponent(`userName eq "olga@${DOMAIN_B}"`)}`);
		expect(miss.body.totalResults).toBe(0);
		expect((await scim(tokens.own, 'GET', 'Users?filter=name%20co%20%22a%22')).body.scimType).toBe('invalidFilter');
		expect((await scim(tokens.olga, 'GET', `Users/${ids.staff}`)).status).toBe(404);
		expect((await deactivate(tokens.olga, ids.staff)).status).toBe(404);
		expect(await statusOf(ids.staff)).toEqual({ status: 'active', by: null });
		expect((await scim(tokens.own, 'GET', 'Users/not-a-uuid')).status).toBe(404);
	});

	it('creates people in verified domains only', async () => {
		const email = `new-${run}@${DOMAIN_A}`;
		const made = await scim(tokens.own, 'POST', 'Users', {
			schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
			userName: email,
			name: { givenName: 'Nova', familyName: 'Reyes' },
			active: true
		});
		expect(made.status).toBe(201);
		expect(made.body).toMatchObject({ userName: email, active: true });
		const [u] = await ownerPool().sql<{ name: string; password_hash: string }[]>`
			select name, password_hash from users where email = ${email}`;
		expect(u).toEqual({ name: 'Nova Reyes', password_hash: '!sso' });
		expect(await statusOf(made.body.id as string)).toEqual({ status: 'active', by: null });
		const again = await scim(tokens.own, 'POST', 'Users', { userName: email.toUpperCase() });
		expect([again.status, again.body.scimType]).toEqual([409, 'uniqueness']);
		const outside = await scim(tokens.own, 'POST', 'Users', { userName: `x-${run}@${DOMAIN_B}` });
		expect([outside.status, outside.body.scimType]).toEqual([400, 'invalidValue']);
		const sub = await scim(tokens.own, 'POST', 'Users', { userName: `x-${run}@sub.${DOMAIN_A}` });
		expect(sub.status).toBe(400);
		const off = await scim(tokens.own, 'POST', 'Users', { userName: `off-${run}@${DOMAIN_A}`, active: 'False' });
		expect(off.body.active).toBe(false);
		expect(await statusOf(off.body.id as string)).toEqual({ status: 'disabled', by: 'scim' });
		expect((await scim(tokens.own, 'POST', 'Users', 'not json')).body.scimType).toBe('invalidSyntax');
		expect((await scim(tokens.own, 'POST', 'Users', { userName: 'x'.repeat(70_000) })).status).toBe(413);
	});

	it('creates one membership when the same person arrives twice at once', async () => {
		const email = `twice-${run}@${DOMAIN_A}`;
		const res = await Promise.all([1, 2, 3].map(() => scim(tokens.own, 'POST', 'Users', { userName: email })));
		expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409]);
		const [{ n }] = await ownerPool().sql<{ n: number }[]>`
			select count(*)::int as n from audit_log where event = 'scim.create' and row_id = ${res.find((r) => r.status === 201)!.body.id as string}`;
		expect(n).toBe(1);
	});

	it('adds an existing account without touching it', async () => {
		const email = `known-${run}@${DOMAIN_A}`;
		const u = await createUser(email);
		const before = (await ownerPool().db.select().from(users).where(eq(users.id, u.id)))[0];
		const added = await scim(tokens.own, 'POST', 'Users', { userName: email, displayName: 'Someone Else' });
		expect(added.status).toBe(201);
		expect(Object.keys(added.body).sort()).toEqual(['active', 'emails', 'id', 'meta', 'schemas', 'userName']);
		expect((await ownerPool().db.select().from(users).where(eq(users.id, u.id)))[0]).toEqual(before);
	});

	it('deactivates and reactivates people it turned off', async () => {
		const { token } = await createSession(who.staff.user.userId, {}, tenant.id);
		const off = await deactivate(tokens.own, ids.staff);
		expect([off.status, off.body.active]).toEqual([200, false]);
		expect(await statusOf(ids.staff)).toEqual({ status: 'disabled', by: 'scim' });
		expect(await validateSession(token)).toBeNull();
		const on = await activate(tokens.own, ids.staff);
		expect(on.body.active).toBe(true);
		expect(await statusOf(ids.staff)).toEqual({ status: 'active', by: null });
		const put = await scim(tokens.own, 'PUT', `Users/${ids.staff}`, { userName: 'ignored@x.example', active: false });
		expect([put.status, put.body.userName]).toEqual([200, `staff@${DOMAIN_A}`]);
		expect((await scim(tokens.own, 'DELETE', `Users/${ids.staff}`)).status).toBe(204);
		expect(await statusOf(ids.staff)).toEqual({ status: 'disabled', by: 'scim' });
		const { token: again } = await createSession(who.staff.user.userId, {}, tenant.id);
		expect((await scim(tokens.own, 'DELETE', `Users/${ids.staff}`)).status).toBe(204);
		expect(await validateSession(again)).toBeNull();
		await activate(tokens.own, ids.staff);
		const events = await ownerPool()
			.db.select({ action: auditLog.event })
			.from(auditLog)
			.where(eq(auditLog.rowId, ids.staff));
		expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['scim.deactivate', 'scim.reactivate']));
	});

	it('never turns back on someone HR or an exit turned off', async () => {
		await setMemberStatus(toActor(who.own), ids.held, 'disabled');
		expect(await statusOf(ids.held)).toEqual({ status: 'disabled', by: 'hr' });
		const tried = await activate(tokens.own, ids.held);
		expect([tried.status, tried.body.active]).toEqual([200, false]);
		expect(await statusOf(ids.held)).toEqual({ status: 'disabled', by: 'hr' });
		await deactivate(tokens.own, ids.held);
		await activate(tokens.own, ids.held);
		expect(await statusOf(ids.held)).toEqual({ status: 'disabled', by: 'hr' });
		await setMemberStatus(toActor(who.own), ids.held, 'active');
		await deactivate(tokens.own, ids.held);
		await setMemberStatus(toActor(who.own), ids.held, 'disabled');
		expect(await statusOf(ids.held)).toEqual({ status: 'disabled', by: 'hr' });
		await activate(tokens.own, ids.held);
		expect(await statusOf(ids.held)).toEqual({ status: 'disabled', by: 'hr' });

		await ownerPool().sql`update memberships set status = 'ex_employee', disabled_by = 'exit' where id = ${ids.gone}`;
		const { token } = await createSession(who.gone.user.userId, {}, tenant.id);
		await deactivate(tokens.own, ids.gone);
		expect(await statusOf(ids.gone)).toEqual({ status: 'ex_employee', by: 'exit' });
		expect(await validateSession(token)).toBeNull();
		await ownerPool().sql`update memberships set status = 'disabled' where id = ${ids.gone}`;
		await activate(tokens.own, ids.gone);
		expect(await statusOf(ids.gone)).toEqual({ status: 'disabled', by: 'exit' });
	});

	it('leaves owners to the app', async () => {
		const res = await deactivate(tokens.own, ids.own);
		expect([res.status, res.body.scimType]).toEqual([400, 'mutability']);
		expect((await scim(tokens.own, 'DELETE', `Users/${ids.own}`)).status).toBe(400);
		expect(await statusOf(ids.own)).toEqual({ status: 'active', by: null });
	});

	it('rejects malformed patches', async () => {
		expect((await scim(tokens.own, 'PATCH', `Users/${ids.staff}`, { Operations: [] })).body.scimType).toBe(
			'invalidSyntax'
		);
		const bad = await scim(tokens.own, 'PATCH', `Users/${ids.staff}`, {
			schemas: [PATCH],
			Operations: [{ op: 'replace', path: 'active', value: 'maybe' }]
		});
		expect([bad.status, bad.body.scimType]).toEqual([400, 'invalidValue']);
		expect(await statusOf(ids.staff)).toEqual({ status: 'active', by: null });
	});

	it('stops working when the token is replaced, revoked or the organisation is suspended', async () => {
		const old = tokens.olga;
		await confirmRecentAuth(who.olga.user, PASSWORD, '');
		tokens.olga = await createScimToken(who.olga);
		expect((await scim(old, 'GET', 'Users')).status).toBe(401);
		expect((await scim(tokens.olga, 'GET', 'Users')).status).toBe(200);
		await ownerPool().sql`update tenants set status = 'suspended' where id = ${other.id}`;
		expect((await scim(tokens.olga, 'GET', 'Users')).status).toBe(401);
		await ownerPool().sql`update tenants set status = 'active' where id = ${other.id}`;
		await revokeScimToken(who.olga);
		expect((await scim(tokens.olga, 'GET', 'Users')).status).toBe(401);
		expect((await withTenant(sys(other), loadSso)).connection!.scimPrefix).toBeNull();
	});

	it('locks out an address after repeated bad tokens', async () => {
		const ip = '203.0.113.72';
		await (await redisReady()).del(rkey('rl', 'scim-auth-fail', ip));
		const tries = await Promise.all(Array.from({ length: 30 }, () => scim('nope', 'GET', 'Users', undefined, ip)));
		expect(new Set(tries.map((t) => t.status))).toEqual(new Set([401]));
		expect((await scim('nope', 'GET', 'Users', undefined, ip)).status).toBe(429);
		expect((await scim(tokens.own, 'GET', 'Users', undefined, ip)).status).toBe(200);
	});
});
