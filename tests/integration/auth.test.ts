import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, timeStep } from '../../src/lib/server/auth/totp';
import {
	acceptInvitation,
	beginTotpEnrolment,
	confirmTotpEnrolment,
	login,
	registerFromInvitation,
	requestPasswordReset,
	resetPassword,
	verifyChallenge,
	type LoginResult
} from '../../src/lib/server/auth/service';
import { deleteSession, validateSession } from '../../src/lib/server/auth/session';
import { createUser } from '../../src/lib/server/auth/users';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { processors } from '../../src/lib/server/jobs';
import { provisionTenant } from '../../src/lib/server/platform/tenants';
import { closeQueues, startWorker } from '../../src/lib/server/queue';
import { closeRedis } from '../../src/lib/server/redis';
import { mailLink, waitForMail } from '../mailpit';

const worker = startWorker('mail', processors.mail);

afterAll(async () => {
	await worker.close();
	await Promise.all([closeQueues(), closePools(), closeRedis()]);
});

const PW = 'correct horse battery staple';
const meta = () => ({ ip: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
const newUser = async () => {
	const email = `${randomUUID()}@test.local`;
	return { email, id: await createUser({ email, name: 'Test User', password: PW }) };
};
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const session = (r: LoginResult) => {
	if (r.kind !== 'session') throw new Error(`expected session, got ${JSON.stringify(r)}`);
	return r;
};
const challenge = (r: unknown) => {
	const c = r as LoginResult;
	if (c.kind !== 'challenge') throw new Error(`expected challenge, got ${JSON.stringify(r)}`);
	return c;
};

describe('password sign-in and sessions', () => {
	it('issues a session for the right password and rejects wrong or unknown accounts alike', async () => {
		const u = await newUser();
		expect(await login({ email: u.email, password: 'wrong password here', meta: meta() })).toEqual({ kind: 'invalid' });
		expect(await login({ email: `${randomUUID()}@nobody.local`, password: PW, meta: meta() })).toEqual({
			kind: 'invalid'
		});
		const s = session(await login({ email: u.email.toUpperCase(), password: PW, meta: meta() }));
		expect((await validateSession(s.token))?.userId).toBe(u.id);
		await deleteSession(s.token);
		expect(await validateSession(s.token)).toBeNull();
	});

	it('expires idle sessions and refuses disabled users', async () => {
		const u = await newUser();
		const s = session(await login({ email: u.email, password: PW, meta: meta() }));
		expect(await withTestNow(later(8 * 24 * 3600_000), () => validateSession(s.token))).toBeNull();
		await ownerPool().sql`update users set status = 'disabled' where id = ${u.id}`;
		expect(await login({ email: u.email, password: PW, meta: meta() })).toEqual({ kind: 'invalid' });
	});
});

describe('two-factor', () => {
	it('will not replace an active second factor without turning it off first', async () => {
		const u = await newUser();
		const { secret } = await beginTotpEnrolment(u.id, u.email);
		await confirmTotpEnrolment(u.id, hotp(base32Decode(secret), timeStep(new Date())));
		await expect(beginTotpEnrolment(u.id, u.email)).rejects.toMatchObject({ code: 'totp_enabled' });
	});

	it('enrols, challenges, blocks code replay and accepts a recovery code once', async () => {
		const u = await newUser();
		const { secret } = await beginTotpEnrolment(u.id, u.email);
		const key = base32Decode(secret);
		const codes = await confirmTotpEnrolment(u.id, hotp(key, timeStep(new Date())));
		expect(codes).toHaveLength(10);

		const c1 = challenge(await login({ email: u.email, password: PW, meta: meta() }));
		expect(c1.stage).toBe('totp');
		const at = later(60_000);
		const code = hotp(key, timeStep(new Date(at)));
		const s = await withTestNow(at, () => verifyChallenge(c1.challengeId, code, meta()));
		expect(s.kind).toBe('session');

		const c2 = challenge(await login({ email: u.email, password: PW, meta: meta() }));
		expect(await withTestNow(at, () => verifyChallenge(c2.challengeId, code, meta()))).toMatchObject({ kind: 'wrong' });
		expect((await verifyChallenge(c2.challengeId, codes[0], meta())).kind).toBe('session');

		const c3 = challenge(await login({ email: u.email, password: PW, meta: meta() }));
		expect(await verifyChallenge(c3.challengeId, codes[0], meta())).toMatchObject({ kind: 'wrong' });
	});

	it('drops the challenge after five wrong codes', async () => {
		const u = await newUser();
		const { secret } = await beginTotpEnrolment(u.id, u.email);
		await confirmTotpEnrolment(u.id, hotp(base32Decode(secret), timeStep(new Date())));
		const c = challenge(await login({ email: u.email, password: PW, meta: meta() }));
		for (let i = 0; i < 4; i++) expect((await verifyChallenge(c.challengeId, '000000', meta())).kind).toBe('wrong');
		expect((await verifyChallenge(c.challengeId, '000000', meta())).kind).toBe('expired');
	});
});

describe('step-up after distributed failures', () => {
	it('emails a code to finish sign-in unless the device is trusted', async () => {
		const u = await newUser();
		const trusted = session(await login({ email: u.email, password: PW, meta: meta() })).trustedDevice;
		for (let i = 0; i < 3; i++) await login({ email: u.email, password: 'wrong password here', meta: meta() });
		await new Promise((r) => setTimeout(r, 3100));
		const c = challenge(await login({ email: u.email, password: PW, meta: meta() }));
		expect(c.stage).toBe('stepup');
		const mail = await waitForMail(u.email);
		const code = mail.text.match(/code is (\d{6})/)?.[1];
		expect(code).toBeTruthy();
		expect((await verifyChallenge(c.challengeId, code!, meta())).kind).toBe('session');
		expect((await login({ email: u.email, password: PW, meta: meta(), trustedDevice: trusted })).kind).toBe('session');
	});
});

describe('password reset', () => {
	it('resets once via the mailed link and signs out every session', async () => {
		const u = await newUser();
		const s = session(await login({ email: u.email, password: PW, meta: meta() }));
		await requestPasswordReset(u.email, meta().ip);
		await requestPasswordReset(`${randomUUID()}@nobody.local`, meta().ip);
		const token = mailLink((await waitForMail(u.email)).text)
			.split('/')
			.pop()!;
		await expect(resetPassword(token, 'password123')).rejects.toMatchObject({ code: 'weak_password' });
		await resetPassword(token, 'a brand new passphrase');
		await expect(resetPassword(token, 'another new passphrase')).rejects.toMatchObject({ code: 'invalid_token' });
		expect(await validateSession(s.token)).toBeNull();
		expect((await login({ email: u.email, password: 'a brand new passphrase', meta: meta() })).kind).toBe('session');
	});
});

describe('invitations', () => {
	it('registers a new user into the tenant with the invited and employee roles, once', async () => {
		const ownerEmail = `${randomUUID()}@test.local`;
		const t = await provisionTenant({ slug: `inv-${randomUUID().slice(0, 8)}`, name: 'Inv', ownerEmail }, null);
		const r = await registerFromInvitation(t.invitationToken, { name: 'Owner', password: PW }, meta());
		expect(r.tenantSlug).toBe(t.slug);
		const roles = await ownerPool().sql`
			select r.key from membership_roles mr join roles r on r.id = mr.role_id
			join memberships m on m.id = mr.membership_id join users u on u.id = m.user_id
			where u.email = ${ownerEmail} order by r.key`;
		expect(roles.map((x) => x.key)).toEqual(['employee', 'owner']);
		await expect(
			registerFromInvitation(t.invitationToken, { name: 'Again', password: PW }, meta())
		).rejects.toMatchObject({
			code: 'invitation_invalid'
		});
	});

	it('refuses to accept an invitation for a different email', async () => {
		const t = await provisionTenant(
			{ slug: `inv-${randomUUID().slice(0, 8)}`, name: 'Inv', ownerEmail: `${randomUUID()}@test.local` },
			null
		);
		const other = await newUser();
		await expect(acceptInvitation(t.invitationToken, other.id)).rejects.toMatchObject({
			code: 'invitation_email_mismatch'
		});
	});
});
