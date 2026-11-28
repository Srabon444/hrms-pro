import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODULE_IDS, MODULES } from '../../src/lib/modules';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { createSession, markReauth } from '../../src/lib/server/auth/session';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { memberships } from '../../src/lib/server/db/schema';
import {
	addSigner,
	cancelRequest,
	createRequest,
	declineInternal,
	otpMac,
	removeSigner,
	requestFile,
	requestPage,
	resendInvite,
	sendRequest,
	signaturesPage,
	signInternal
} from '../../src/lib/server/esign';
import { saveModules } from '../../src/lib/server/modules';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { declineExternal, sendCode, signDocument, signExternal, signView } from '../../src/lib/server/public/esign';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import {
	addCandidate,
	decideOffer,
	makeOffer,
	purgeTenantCandidates,
	saveOpening
} from '../../src/lib/server/recruitment';
import { closeQueues } from '../../src/lib/server/queue';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { getObject } from '../../src/lib/server/storage';
import { systemCtx, withTenant, type TenantCtx } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let tenant: Tenant;
let other: Tenant;
const who: Record<string, Member> = {};
const emp: Record<string, string> = {};
const sql = () => ownerPool().sql;
const NOW = '2026-11-28T06:00:00.000Z';
const IP = '198.51.100.20';
const UA = 'Mozilla/5.0 test';
const later = (days: number) => new Date(Date.parse(NOW) + days * 86_400_000).toISOString();
const at = <T>(iso: string, fn: () => Promise<T>) => withTestNow(iso, fn);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; message?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const message = (p: Promise<unknown>) => p.then(() => 'ok').catch((e: Error) => e.message);
const pdf = (text = 'offer letter', name = 'letter.pdf') =>
	new File([new TextEncoder().encode(`%PDF-1.7\n${text}`)], name, { type: 'application/pdf' });
const formOf = (fields: Record<string, string | File>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.append(k, v);
	return f;
};
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function member(t: Tenant, key: string, roleKeys: string[], status = 'active') {
	const u = await createUser();
	const [e] = await sql()<{ id: string }[]>`
		insert into employees (tenant_id, code, full_name, work_email, employment_type, status, join_date)
		values (${t.id}, ${key}, ${`${key} person`}, ${`${key}-${t.slug}@example.com`}, 'full_time', ${status}, '2024-01-01')
		returning id`;
	emp[key] = e.id;
	const m = await withTenant(systemCtx(t.id), async (tx) => {
		const id = await addMember(tx, t.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId: e.id }).where(eq(memberships.id, id));
		return id;
	});
	const { token } = await createSession(u.id, {});
	who[key] = {
		user: { userId: u.id, email: u.email, sessionId: sha256(token), totpEnabled: false },
		tenant: { id: t.id, slug: t.slug, name: `${key} org` },
		access: await loadAccess(t.id, { id: m, status: 'active', employeeId: e.id })
	} as unknown as Member;
}

const reauth = (k: string, iso = NOW) => at(iso, () => markReauth(who[k].user.sessionId));

async function draft(title: string, extra: Record<string, string> = {}) {
	return at(NOW, () => createRequest(who.hr, formOf({ title, expiresInDays: '7', file: pdf(title), ...extra })));
}

const signers = (requestId: string) =>
	sql()<
		{
			id: string;
			name: string;
			email: string;
			status: string;
			otp_attempts: number;
			otp_sends: number;
			token_hash: string | null;
			method: string | null;
			ip: string | null;
			user_agent: string | null;
		}[]
	>`select id, name, email, status, otp_attempts, otp_sends, token_hash, method, ip, user_agent
		from signature_signers where request_id = ${requestId} order by sort_order`;

const requestRow = (id: string) =>
	sql()<
		{
			status: string;
			file_key: string;
			sha256: string;
			certificate_key: string | null;
			certificate_sha256: string | null;
			decline_reason: string | null;
		}[]
	>`select status, file_key, sha256, certificate_key, certificate_sha256, decline_reason
		from signature_requests where id = ${id}`.then((r) => r[0]);

async function linkFor(signerId: string) {
	const token = crypto.randomUUID().replaceAll('-', '').padEnd(43, 'x');
	await sql()`update signature_signers set token_hash = ${sha256(token)} where id = ${signerId}`;
	return token;
}

async function knownCode(signerId: string, value = '123456', iso = NOW) {
	await sql()`update signature_signers set otp_hash = ${otpMac(signerId, value)},
		otp_expires_at = ${new Date(Date.parse(iso) + 600_000).toISOString()} where id = ${signerId}`;
}

const signOut = (token: string, fields: Record<string, string>, iso = NOW) =>
	at(iso, () => signExternal(token, IP, UA, formOf({ typedName: 'Outside Signer', consent: 'on', ...fields })));

const resetLimits = async () =>
	(await redisReady()).del(rkey('rl', 'esign-fail', IP), rkey('rl', 'esign-fail', '198.51.100.99'));

beforeAll(async () => {
	tenant = await createTenant('sig');
	other = await createTenant('sigb');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(systemCtx(other.id), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	await member(tenant, 'hr', ['hr_admin']);
	await member(tenant, 'boss', []);
	await member(tenant, 'peer', []);
	await member(tenant, 'gone', [], 'exited');
	await member(other, 'stranger', ['owner']);
	const base = MODULE_IDS.filter((id) => MODULES[id].on);
	await saveModules(systemCtx(tenant.id), [...base, 'esign', 'talent']);
	await saveModules(systemCtx(other.id), [...base, 'esign']);
	await resetLimits();
});

afterAll(async () => {
	await Promise.all([closeQueues(), closePools(), closeRedis()]);
});

describe('building a request', () => {
	it('takes a PDF from a manager only and stores its hash', async () => {
		expect(await code(at(NOW, () => createRequest(who.peer, formOf({ title: 'x', file: pdf() }))))).toBe('forbidden');
		expect(
			await code(
				at(NOW, () =>
					createRequest(who.hr, formOf({ title: 'x', file: new File(['GIF89a'], 'a.pdf', { type: 'image/gif' }) }))
				)
			)
		).toBe('unsupported_file');
		expect(
			await code(at(NOW, () => createRequest(who.hr, formOf({ title: 'x', expiresInDays: '91', file: pdf() }))))
		).toBe('invalid: Allow 1 to 90 days to sign.');
		expect(await code(at(NOW, () => createRequest(who.hr, formOf({ title: 'a‮b', file: pdf() }))))).toBe(
			'invalid: Remove unsupported characters.'
		);
		expect(await code(at(NOW, () => createRequest(who.hr, formOf({ title: 'Pay\u200bment', file: pdf() }))))).toBe(
			'invalid: Remove unsupported characters.'
		);
		const id = await draft('Policy acknowledgement');
		const r = await requestRow(id);
		expect(r.status).toBe('draft');
		expect(r.sha256).toBe(digest(await getObject(r.file_key)));
	});

	it('adds staff and outside signers with checks, only while a draft', async () => {
		const id = await draft('Checks');
		expect(await code(addSigner(who.hr, { requestId: id, employeeId: emp.gone }))).toBe('invalid_signer');
		expect(await code(addSigner(who.hr, { requestId: id, employeeId: emp.stranger }))).toBe('invalid_signer');
		expect(await code(addSigner(who.hr, { requestId: id, name: 'X', email: 'nope' }))).toBe(
			'invalid: Enter a valid email for the signer.'
		);
		expect(await code(addSigner(who.peer, { requestId: id, name: 'X', email: 'x@example.com' }))).toBe('forbidden');
		await addSigner(who.hr, { requestId: id, employeeId: emp.boss });
		await addSigner(who.hr, { requestId: id, name: 'Out Side', email: 'Out@Example.com' });
		expect(await code(addSigner(who.hr, { requestId: id, name: 'Again', email: 'out@example.com' }))).toBe(
			'duplicate_signer'
		);
		const list = await signers(id);
		expect(list.map((s) => [s.name, s.email])).toEqual([
			['boss person', who.boss.user.email.toLowerCase()],
			['Out Side', 'out@example.com']
		]);
		for (let i = 0; i < 8; i++) await addSigner(who.hr, { requestId: id, name: `P${i}`, email: `p${i}@example.com` });
		expect(await code(addSigner(who.hr, { requestId: id, name: 'P11', email: 'p11@example.com' }))).toBe('too_many');
		await removeSigner(who.hr, { signerId: list[1].id });
		expect(await code(at(NOW, () => sendRequest(who.hr, { requestId: id })))).toBe('ok');
		expect(await code(removeSigner(who.hr, { signerId: list[0].id }))).toBe('sent');
		expect(await code(addSigner(who.hr, { requestId: id, name: 'Late', email: 'late@example.com' }))).toBe('sent');
	});

	it('starts the signing window when the request is sent', async () => {
		const id = await draft('Late send');
		await addSigner(who.hr, { requestId: id, name: 'Late Signer', email: 'late@example.com' });
		await at(later(6), () => sendRequest(who.hr, { requestId: id }));
		const [r] = await sql()<{ expires_at: Date }[]>`select expires_at from signature_requests where id = ${id}`;
		expect(new Date(r.expires_at).toISOString()).toBe(later(13));
	});

	it('refuses to send without signers and lets a draft be cancelled', async () => {
		const id = await draft('Empty');
		expect(await code(at(NOW, () => sendRequest(who.hr, { requestId: id })))).toBe('no_signers');
		await cancelRequest(who.hr, { requestId: id });
		expect((await requestRow(id)).status).toBe('cancelled');
		expect(await code(cancelRequest(who.hr, { requestId: id }))).toBe('closed');
	});
});

describe('signing in order', () => {
	let id: string;
	let outside: string;

	beforeAll(async () => {
		id = await draft('Contract');
		await addSigner(who.hr, { requestId: id, employeeId: emp.boss });
		await addSigner(who.hr, { requestId: id, name: 'Outside Signer', email: 'outside@example.com' });
		await at(NOW, () => sendRequest(who.hr, { requestId: id }));
		outside = (await signers(id))[1].id;
	});

	it('invites only the first signer and keeps the draft away from signers', async () => {
		const list = await signers(id);
		expect(list.map((s) => s.token_hash)).toEqual([null, null]);
		const page = await at(NOW, () => signaturesPage(who.boss));
		expect(page.mine.find((r) => r.id === id)?.myTurn).toBe(true);
		expect(page.all).toEqual([]);
		const d = await draft('Hidden draft');
		await addSigner(who.hr, { requestId: d, employeeId: emp.boss });
		expect(await code(at(NOW, () => requestPage(who.boss, d)))).toBe('not_found');
		expect(await code(at(NOW, () => requestPage(who.peer, id)))).toBe('not_found');
		expect(await code(at(NOW, () => requestPage(who.stranger, id)))).toBe('not_found');
		const view = await at(NOW, () => requestPage(who.boss, id));
		expect(view.myTurn).toBe(true);
		expect(view.signers.map((s) => [s.email, s.ip])).toEqual([
			[null, null],
			[null, null]
		]);
	});

	it('needs a fresh password check for staff and refuses out of turn', async () => {
		expect(
			await code(
				at(NOW, () =>
					signInternal(who.boss, { requestId: id, typedName: 'Boss', consent: 'on' }, { ip: IP, userAgent: UA })
				)
			)
		).toBe('reauth_required');
		await reauth('peer');
		expect(
			await code(
				at(NOW, () =>
					signInternal(who.peer, { requestId: id, typedName: 'Peer', consent: 'on' }, { ip: IP, userAgent: UA })
				)
			)
		).toBe('not_your_turn');
		await reauth('boss');
		expect(
			await code(
				at(NOW, () =>
					signInternal(who.boss, { requestId: id, typedName: 'Boss', consent: '' }, { ip: IP, userAgent: UA })
				)
			)
		).toBe('invalid: Agree to sign electronically.');
		await at(NOW, () =>
			signInternal(
				who.boss,
				{ requestId: id, typedName: 'Boss Person', consent: 'on' },
				{ ip: IP, userAgent: `${UA}\u0007` }
			)
		);
		const [boss, out] = await signers(id);
		expect([boss.status, boss.method, boss.ip, boss.user_agent]).toEqual(['signed', 'session', IP, UA]);
		expect(out.token_hash).not.toBeNull();
		expect(
			await code(
				at(NOW, () =>
					signInternal(who.boss, { requestId: id, typedName: 'Boss', consent: 'on' }, { ip: IP, userAgent: UA })
				)
			)
		).toBe('not_your_turn');
	});

	it('limits codes to 3 sends and 5 tries, and a resend never resets the tries', async () => {
		const token = await linkFor(outside);
		const view = await at(NOW, () => signView(token, IP));
		expect([view.state, view.sendsLeft, view.attemptsLeft, view.sha256]).toEqual([
			'ready',
			3,
			5,
			(await requestRow(id)).sha256
		]);
		expect(await code(signOut(token, { code: '000000' }))).toBe('no_code');
		expect((await signers(id))[1].otp_attempts).toBe(0);
		expect(await at(NOW, () => sendCode(token, IP))).toBe('o***@example.com');
		await knownCode(outside, '111111');
		expect(await message(signOut(token, { code: '222222' }))).toBe('That code is not right. 4 tries are left.');
		expect(await message(signOut(token, { code: '222222' }))).toBe('That code is not right. 3 tries are left.');
		await at(NOW, () => sendCode(token, IP));
		await at(NOW, () => sendCode(token, IP));
		expect(await code(at(NOW, () => sendCode(token, IP)))).toBe('no_more_codes');
		const after = (await signers(id))[1];
		expect([after.otp_sends, after.otp_attempts]).toEqual([3, 2]);
		await knownCode(outside, '111111');
		expect(await message(signOut(token, { code: '111111' }, later(1)))).toBe('That code has expired. Send a new code.');
		expect(await message(signOut(token, { code: '333333' }))).toBe('That code is not right. 1 try is left.');
		expect(await message(signOut(token, { code: '333333' }))).toBe(
			'That code is not right and no tries are left. Ask the sender for a new request.'
		);
		expect((await at(NOW, () => signView(token, IP))).state).toBe('locked');
		expect(await code(signOut(token, { code: '111111' }))).toBe('locked');
		expect((await signers(id))[1].status).toBe('waiting');
		const failed = await sql()<{ n: number }[]>`select count(*)::int as n from audit_log
			where row_id = ${outside} and event = 'code_failed' and actor_kind = 'signature'`;
		expect(failed[0].n).toBe(5);
	});
});

describe('completion', () => {
	it('produces a certificate whose hash matches, beside the untouched original', async () => {
		const id = await draft('Agreement');
		await addSigner(who.hr, { requestId: id, name: 'Outside Signer', email: 'done@example.com' });
		await addSigner(who.hr, { requestId: id, employeeId: emp.boss });
		await at(NOW, () => sendRequest(who.hr, { requestId: id }));
		const [out] = await signers(id);
		const token = await linkFor(out.id);
		await knownCode(out.id);
		expect((await at(NOW, () => signDocument(token, IP))).body.byteLength).toBeGreaterThan(0);
		await signOut(token, { code: '123456' });
		expect(await code(signOut(token, { code: '123456' }))).toBe('signed');
		await reauth('boss');
		await at(NOW, () =>
			signInternal(who.boss, { requestId: id, typedName: 'Boss Person', consent: 'on' }, { ip: null, userAgent: '' })
		);
		const r = await requestRow(id);
		expect(r.status).toBe('completed');
		const cert = await getObject(r.certificate_key!);
		expect(digest(cert)).toBe(r.certificate_sha256);
		expect(Buffer.from(cert.subarray(0, 5)).toString()).toBe('%PDF-');
		const original = await at(NOW, () => requestFile(who.boss, id, 'original'));
		expect(digest(original.body)).toBe(r.sha256);
		expect(digest((await at(NOW, () => requestFile(who.hr, id, 'certificate'))).body)).toBe(r.certificate_sha256);
		expect(await code(at(NOW, () => requestFile(who.peer, id, 'certificate')))).toBe('not_found');
		const events = await sql()<{ event: string; actor_kind: string }[]>`select event, actor_kind from audit_log
			where (row_id = ${id} or row_id in (select id from signature_signers where request_id = ${id})) and event is not null
			order by created_at`;
		expect(events.map((e) => e.event)).toEqual(['sent', 'signed', 'signed', 'completed']);
		expect(events.slice(1).every((e) => e.actor_kind === 'signature')).toBe(true);
		const told = await sql()<{ title: string }[]>`select title from notifications
			where membership_id = ${who.hr.access.membershipId} and category = 'signatures'`;
		expect(told.map((t) => t.title)).toContain('Signed by everyone: Agreement');
		expect(await code(cancelRequest(who.hr, { requestId: id }))).toBe('closed');
	});

	it('records a decline with its reason and stops the request', async () => {
		const id = await draft('Declined one');
		await addSigner(who.hr, { requestId: id, name: 'No Thanks', email: 'no@example.com' });
		await addSigner(who.hr, { requestId: id, employeeId: emp.boss });
		await at(NOW, () => sendRequest(who.hr, { requestId: id }));
		const [out] = await signers(id);
		const token = await linkFor(out.id);
		await knownCode(out.id);
		await at(NOW, () => declineExternal(token, IP, formOf({ code: '123456', reason: 'Wrong salary' })));
		expect(await requestRow(id)).toMatchObject({ status: 'declined', decline_reason: 'Wrong salary' });
		expect((await at(NOW, () => signView(token, IP))).state).toBe('declined');
		expect(await code(at(NOW, () => signDocument(token, IP)))).toBe('not_found');
		await reauth('boss');
		expect(await code(at(NOW, () => declineInternal(who.boss, { requestId: id })))).toBe('closed');
	});

	it('resends an invite with a new link and closes a signed signer link once cancelled', async () => {
		const id = await draft('Cancelled midway');
		await addSigner(who.hr, { requestId: id, name: 'First Signer', email: 'first@example.com' });
		await addSigner(who.hr, { requestId: id, name: 'Second Signer', email: 'second@example.com' });
		await at(NOW, () => sendRequest(who.hr, { requestId: id }));
		const [first] = await signers(id);
		const before = first.token_hash;
		await at(NOW, () => resendInvite(who.hr, { requestId: id }));
		expect((await signers(id))[0].token_hash).not.toBe(before);
		const token = await linkFor(first.id);
		await knownCode(first.id);
		await signOut(token, { code: '123456' });
		expect(await code(at(NOW, () => signDocument(token, IP)))).toBe('ok');
		await cancelRequest(who.hr, { requestId: id });
		expect(await code(at(NOW, () => signDocument(token, IP)))).toBe('not_found');
		expect(await code(at(NOW, () => resendInvite(who.hr, { requestId: id })))).toBe('closed');
	});

	it('expires lazily and closes links when the module is off or the tenant is suspended', async () => {
		const id = await draft('Short');
		await addSigner(who.hr, { requestId: id, name: 'Slow Signer', email: 'slow@example.com' });
		await at(NOW, () => sendRequest(who.hr, { requestId: id }));
		const [out] = await signers(id);
		const token = await linkFor(out.id);
		expect((await at(later(8), () => signView(token, IP))).state).toBe('expired');
		expect(await code(at(later(8), () => sendCode(token, IP)))).toBe('expired');
		expect((await at(later(8), () => requestPage(who.hr, id))).request.status).toBe('expired');
		await saveModules(systemCtx(tenant.id), [...MODULE_IDS.filter((m) => MODULES[m].on), 'talent']);
		expect(await code(at(NOW, () => signView(token, IP)))).toBe('not_found');
		await saveModules(systemCtx(tenant.id), [...MODULE_IDS.filter((m) => MODULES[m].on), 'esign', 'talent']);
		await sql()`update tenants set status = 'suspended' where id = ${tenant.id}`;
		expect(await code(at(NOW, () => signView(token, IP)))).toBe('not_found');
		await sql()`update tenants set status = 'active' where id = ${tenant.id}`;
		expect((await at(NOW, () => signView(token, IP))).state).toBe('ready');
		await resetLimits();
	});

	it('locks out an address after repeated bad links', async () => {
		const bad = '198.51.100.99';
		for (let i = 0; i < 20; i++) await code(at(NOW, () => signView(`bad${i}`, bad)));
		expect(await code(at(NOW, () => signView('x'.repeat(43), bad)))).toBe('busy');
		await resetLimits();
	});
});

describe('offer letters', () => {
	let ctx: TenantCtx;
	let offerId: string;
	let candidateId: string;

	beforeAll(async () => {
		ctx = { tenantId: tenant.id, actor: 'user', userId: who.hr.user.userId };
		const opening = await saveOpening(ctx, {
			title: 'Analyst',
			departmentId: '',
			designationId: '',
			headcount: '1',
			description: ''
		});
		candidateId = await addCandidate(
			ctx,
			{ openingId: opening, fullName: 'Rina Akter', email: 'rina@example.com', phone: '' },
			null
		);
		await at(NOW, () =>
			makeOffer(ctx, { candidateId, monthlyGross: '50000', joinDate: '2027-01-15', expiresOn: '2026-12-01' })
		);
		[{ id: offerId }] = await sql()<{ id: string }[]>`select id from offers where candidate_id = ${candidateId}`;
	});

	it('accepts the offer as soon as the candidate signs, with actor signature, before the countersigner', async () => {
		expect(await code(draft('Not mine', { offerId: crypto.randomUUID() }))).toBe('not_found');
		const id = await draft('Offer letter', { offerId });
		expect(await code(draft('Twice', { offerId }))).toBe('offer_linked');
		await addSigner(who.hr, { requestId: id, employeeId: emp.boss });
		const [rina, boss] = await signers(id);
		expect([rina.email, boss.email]).toEqual(['rina@example.com', who.boss.user.email.toLowerCase()]);
		expect(await code(removeSigner(who.hr, { signerId: rina.id }))).toBe('candidate');
		const noHiring = {
			...who.hr,
			access: { ...who.hr.access, grants: { 'signature.manage': who.hr.access.grants['signature.manage'] } }
		} as Member;
		expect(await code(at(NOW, () => sendRequest(noHiring, { requestId: id })))).toBe('forbidden');
		await at(NOW, () => sendRequest(who.hr, { requestId: id }));
		const token = await linkFor(rina.id);
		await knownCode(rina.id, '654321', later(4));
		expect(await message(signOut(token, { code: '654321' }, later(4)))).toBe('This offer has expired.');
		expect((await signers(id))[0].status).toBe('waiting');
		await knownCode(rina.id, '654321');
		await signOut(token, { code: '654321' });
		const [o] = await sql()<{ status: string }[]>`select status from offers where id = ${offerId}`;
		expect(o.status).toBe('accepted');
		const [audit] = await sql()<{ actor_kind: string }[]>`select actor_kind from audit_log
			where table_name = 'offers' and row_id = ${offerId} and op = 'UPDATE'`;
		expect(audit.actor_kind).toBe('signature');
		expect((await requestRow(id)).status).toBe('pending');
		await reauth('boss');
		await at(NOW, () =>
			signInternal(who.boss, { requestId: id, typedName: 'Boss', consent: 'on' }, { ip: IP, userAgent: UA })
		);
		expect((await requestRow(id)).status).toBe('completed');
	});

	it('refuses an expired offer at send and cancels the request when HR decides the offer', async () => {
		const opening = await saveOpening(ctx, {
			title: 'Clerk',
			departmentId: '',
			designationId: '',
			headcount: '1',
			description: ''
		});
		const other = await addCandidate(
			ctx,
			{ openingId: opening, fullName: 'Sami Khan', email: 'sami@example.com', phone: '' },
			null
		);
		await at(NOW, () =>
			makeOffer(ctx, { candidateId: other, monthlyGross: '40000', joinDate: '2027-01-15', expiresOn: '2026-12-01' })
		);
		const [{ id: second }] = await sql()<{ id: string }[]>`select id from offers where candidate_id = ${other}`;
		const id = await draft('Second offer', { offerId: second });
		expect(await message(at(later(4), () => sendRequest(who.hr, { requestId: id })))).toBe('This offer has expired.');
		await at(NOW, () => sendRequest(who.hr, { requestId: id }));
		const token = await linkFor((await signers(id))[0].id);
		await at(NOW, () => decideOffer(ctx, { offerId: second, decision: 'withdrawn' }));
		expect((await requestRow(id)).status).toBe('cancelled');
		expect((await at(NOW, () => signView(token, IP))).state).toBe('closed');
	});

	it('deletes the signed letter and its certificate when the candidate is purged', async () => {
		const [r] = await sql()<{ id: string; file_key: string; certificate_key: string }[]>`
			select id, file_key, certificate_key from signature_requests where offer_id = ${offerId}`;
		await sql()`update candidates set stage_id = (select id from pipeline_stages ps
			where ps.opening_id = candidates.opening_id and ps.kind = 'rejected' limit 1) where id = ${candidateId}`;
		expect(await at(later(500), () => purgeTenantCandidates(tenant.id))).toBeGreaterThan(0);
		expect(await sql()`select 1 from signature_requests where id = ${r.id}`).toHaveLength(0);
		expect(await code(getObject(r.file_key))).not.toBe('ok');
		expect(await code(getObject(r.certificate_key))).not.toBe('ok');
		const kept = await sql()<{ n: number }[]>`select count(*)::int as n from audit_log
			where table_name = 'signature_signers' and coalesce(old_values::text, '') || coalesce(new_values::text, '') ilike '%rina%'`;
		expect(kept[0].n).toBe(0);
	});
});
