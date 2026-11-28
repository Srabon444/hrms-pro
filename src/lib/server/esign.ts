import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { activeMembershipsOf } from './approval-chain';
import { API_REAUTH_MINUTES } from './api-keys';
import { auditEvent } from './audit';
import { keyedMac, keyedMacMatches, randomToken, sha256 } from './auth/crypto';
import { requireRecentAuth } from './auth/session';
import { now } from './clock';
import { config } from './config';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import {
	candidates,
	memberships,
	offers,
	OTP_MAX_ATTEMPTS,
	OTP_MAX_SENDS,
	signatureRequests,
	signatureSigners,
	tenantSettings
} from './db/schema';
import { AppError } from './errors';
import { field } from './http/forms';
import { log } from './log';
import type { Mail } from './mail';
import { notify } from './notifications';
import { pdfDoc, write } from './pdf';
import { can, userCtx, type requireMember } from './rbac/access';
import { decideOfferTx, liveCandidate, pendingOffer } from './recruitment';
import { pdfName, sniffType } from './sniff';
import { deleteObject, getObject, putObject } from './storage';
import { tenantToday } from './lifecycle';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Request = typeof signatureRequests.$inferSelect;
type Signer = typeof signatureSigners.$inferSelect;
export type SignTenant = { id: string; name: string; slug: string };

export const ESIGN = {
	maxBytes: 10 * 1024 * 1024,
	signers: 10,
	list: 200,
	maxDays: 90,
	otpMinutes: 10
} as const;

const DAY = 86_400_000;
const OTP_PURPOSE = 'esign-otp';
const CONTROL = /[\p{Cc}\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u;
const CONTROLS = new RegExp(CONTROL.source, 'gu');
const clean = (s: z.ZodString) => s.refine((v) => !CONTROL.test(v), 'Remove unsupported characters.');
const id = (message: string) => z.uuid({ error: message });
const optionalId = (message: string) =>
	z
		.union([z.literal(''), z.uuid({ error: message })])
		.transform((v) => v || null)
		.prefault('');

export const LEGAL_NOTE =
	'This is a simple electronic signature with an audit trail. It is not a qualified electronic signature.';
export const CONSENT_TEXT =
	'I agree to sign this document electronically. My typed name is my signature and has the same effect as signing on paper.';

const forbidden = () => new AppError('forbidden', 'You do not have permission to do that.', 403);
const missing = () => new AppError('not_found', 'That signature request does not exist.', 404);

const requireManage = (m: Member) => {
	if (!can(m.access, 'signature.manage')) throw forbidden();
};

const requestSchema = z.object({
	title: clean(z.string().trim().min(1, 'Name the document.').max(200, 'Keep the title under 200 characters.')),
	expiresInDays: z.coerce
		.number(`Allow 1 to ${ESIGN.maxDays} days to sign.`)
		.int(`Allow 1 to ${ESIGN.maxDays} days to sign.`)
		.min(1, `Allow 1 to ${ESIGN.maxDays} days to sign.`)
		.max(ESIGN.maxDays, `Allow 1 to ${ESIGN.maxDays} days to sign.`)
		.prefault('14'),
	offerId: optionalId('Choose an offer from the list.')
});

const signerSchema = z
	.object({
		requestId: id('Choose a request.'),
		employeeId: optionalId('Choose a person from the list.'),
		name: clean(z.string().trim().max(200, 'Keep the name under 200 characters.')).prefault(''),
		email: z.string().trim().toLowerCase().prefault('')
	})
	.transform((v, ctx) => {
		if (v.employeeId) return { requestId: v.requestId, employeeId: v.employeeId, name: '', email: '' };
		if (!v.name) {
			ctx.addIssue({ code: 'custom', message: 'Name the signer or choose a person.' });
			return z.NEVER;
		}
		if (!z.email().max(254).safeParse(v.email).success) {
			ctx.addIssue({ code: 'custom', message: 'Enter a valid email for the signer.' });
			return z.NEVER;
		}
		return v;
	});

export const typedNameSchema = clean(
	z.string().trim().min(1, 'Type your full name to sign.').max(200, 'Keep your name under 200 characters.')
);
export const consentSchema = z.literal('on', 'Agree to sign electronically.');
export const reasonSchema = clean(z.string().trim().max(500, 'Keep the reason under 500 characters.')).prefault('');

const signSchema = z.object({ requestId: id('Choose a request.'), typedName: typedNameSchema, consent: consentSchema });
const declineSchema = z.object({ requestId: id('Choose a request.'), reason: reasonSchema });

export const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const utc = (d: Date) => `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;

export const isExpired = (r: Pick<Request, 'status' | 'expiresAt'>) =>
	r.status === 'pending' && r.expiresAt.getTime() <= now().getTime();

export async function lockedRequest(tx: Tx, requestId: string) {
	const [r] = await tx.select().from(signatureRequests).where(eq(signatureRequests.id, requestId)).for('update');
	if (!r) throw missing();
	return r;
}

const draftOnly = (r: Request) => {
	if (r.status !== 'draft') throw new AppError('sent', 'This request was already sent.', 409);
};

export function openOnly(r: Request) {
	if (r.status !== 'pending') throw new AppError('closed', 'This request is no longer open for signing.', 409);
	if (isExpired(r)) throw new AppError('expired', 'This request has expired.', 409);
}

const signersOf = (tx: Tx, requestId: string) =>
	tx
		.select()
		.from(signatureSigners)
		.where(eq(signatureSigners.requestId, requestId))
		.orderBy(asc(signatureSigners.sortOrder));

export async function currentSigner(tx: Tx, requestId: string): Promise<Signer | undefined> {
	return (await signersOf(tx, requestId)).find((s) => s.status === 'waiting');
}

async function candidateEmail(tx: Tx, offerId: string) {
	const o = await pendingOffer(tx, offerId);
	const c = await liveCandidate(tx, o.candidateId);
	if (!c.email)
		throw new AppError('no_email', 'Add an email to the candidate before sending the offer for signature.', 409);
	if (o.expiresOn && o.expiresOn < (await tenantToday(tx)))
		throw new AppError('expired', 'This offer has expired.', 409);
	return { name: c.fullName, email: c.email.toLowerCase() };
}

export async function createRequest(m: Member, form: FormData): Promise<string> {
	requireManage(m);
	const input = requestSchema.parse({
		title: field(form, 'title'),
		expiresInDays: field(form, 'expiresInDays') || undefined,
		offerId: field(form, 'offerId')
	});
	if (input.offerId && !can(m.access, 'recruitment.manage')) throw forbidden();
	const file = form.get('file');
	if (!(file instanceof File) || !file.size) throw new AppError('no_file', 'Attach the document as a PDF.', 400);
	if (file.size > ESIGN.maxBytes) throw new AppError('too_large', 'The document can be at most 10 MB.', 413);
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (sniffType(bytes, file.name) !== 'application/pdf')
		throw new AppError('unsupported_file', 'Attach the document as a PDF.', 415);
	const key = `t/${m.tenant.id}/signatures/${randomUUID()}`;
	await putObject(key, bytes, 'application/pdf');
	const ctx = userCtx(m);
	try {
		return await withTenant(ctx, async (tx) => {
			const candidate = input.offerId ? await candidateEmail(tx, input.offerId) : null;
			const [r] = await tx
				.insert(signatureRequests)
				.values({
					tenantId: m.tenant.id,
					title: input.title,
					fileKey: key,
					fileName: pdfName(file.name),
					fileSize: bytes.byteLength,
					sha256: hex(bytes),
					createdAt: now(),
					expiresAt: new Date(now().getTime() + input.expiresInDays * DAY),
					offerId: input.offerId,
					createdByUserId: m.user.userId
				})
				.returning({ id: signatureRequests.id });
			if (candidate)
				await tx
					.insert(signatureSigners)
					.values({ tenantId: m.tenant.id, requestId: r.id, sortOrder: 1, candidate: true, ...candidate });
			return r.id;
		});
	} catch (err) {
		await deleteObject(key).catch((e) => log.error({ err: e, key }, 'orphan signature file cleanup failed'));
		if (pgCode(err) === UNIQUE_VIOLATION)
			throw new AppError('offer_linked', 'This offer already has a signature request.', 409);
		throw err;
	}
}

async function internalPerson(tx: Tx, employeeId: string) {
	const rows = await tx.execute<{ name: string; email: string }>(sql`
		select e.full_name as name, lower(tu.email) as email
		from employees e
		join tenant_users tu on tu.employee_id = e.id and tu.membership_status = 'active' and tu.user_status = 'active'
		where e.id = ${employeeId} and e.status <> 'exited'
		limit 1`);
	if (!rows[0]) throw new AppError('invalid_signer', 'Choose a person who can sign in.', 400);
	return rows[0];
}

export async function addSigner(m: Member, raw: Record<string, string>) {
	requireManage(m);
	const input = signerSchema.parse(raw);
	try {
		await withTenant(userCtx(m), async (tx) => {
			const r = await lockedRequest(tx, input.requestId);
			draftOnly(r);
			const [{ n, top }] = await tx
				.select({ n: count(), top: sql<number>`coalesce(max(${signatureSigners.sortOrder}), 0)::int` })
				.from(signatureSigners)
				.where(eq(signatureSigners.requestId, r.id));
			if (n >= ESIGN.signers) throw new AppError('too_many', `A request holds up to ${ESIGN.signers} signers.`, 409);
			const person = input.employeeId
				? { employeeId: input.employeeId, ...(await internalPerson(tx, input.employeeId)) }
				: { employeeId: null, name: input.name, email: input.email };
			await tx
				.insert(signatureSigners)
				.values({ tenantId: m.tenant.id, requestId: r.id, sortOrder: top + 1, ...person });
		});
	} catch (err) {
		if (pgCode(err) === UNIQUE_VIOLATION)
			throw new AppError('duplicate_signer', 'This email is already a signer on the request.', 409);
		throw err;
	}
}

export async function removeSigner(m: Member, raw: Record<string, string>) {
	requireManage(m);
	const signerId = id('Choose a signer.').parse(raw.signerId);
	await withTenant(userCtx(m), async (tx) => {
		const [s] = await tx
			.select({ requestId: signatureSigners.requestId, candidate: signatureSigners.candidate })
			.from(signatureSigners)
			.where(eq(signatureSigners.id, signerId));
		if (!s) throw new AppError('not_found', 'That signer does not exist.', 404);
		draftOnly(await lockedRequest(tx, s.requestId));
		if (s.candidate) throw new AppError('candidate', 'The candidate has to sign an offer letter.', 409);
		await tx.delete(signatureSigners).where(eq(signatureSigners.id, signerId));
	});
}

const signLink = (token: string) => `${config().APP_URL}/sign/${token}`;

async function invite(tx: Tx, tenant: SignTenant, r: Request, s: Signer): Promise<Mail[]> {
	const subject = `Please sign: ${r.title}`;
	if (s.employeeId) {
		await tx.update(signatureSigners).set({ invitedAt: now() }).where(eq(signatureSigners.id, s.id));
		return notify(
			tx,
			tenant.id,
			await activeMembershipsOf(tx, [s.employeeId]),
			{ category: 'signatures', title: subject, link: `signatures/${r.id}` },
			tenant.slug,
			{ ignoreOptOut: true }
		);
	}
	const token = randomToken();
	await tx
		.update(signatureSigners)
		.set({ invitedAt: now(), tokenHash: sha256(token) })
		.where(eq(signatureSigners.id, s.id));
	return [
		{
			to: s.email,
			subject,
			tenantId: tenant.id,
			text: [
				`${tenant.name} asked you to sign "${r.title}".`,
				`Open this link to read and sign it:\n${signLink(token)}`,
				`The link works until ${utc(r.expiresAt)}. Only you should use it; we will email you a code before you sign.`
			].join('\n\n')
		}
	];
}

async function tellCreator(tx: Tx, tenant: SignTenant, r: Request, title: string): Promise<Mail[]> {
	if (!r.createdByUserId) return [];
	const rows = await tx
		.select({ id: memberships.id })
		.from(memberships)
		.where(and(eq(memberships.userId, r.createdByUserId), eq(memberships.status, 'active')));
	return notify(
		tx,
		tenant.id,
		rows.map((x) => x.id),
		{ category: 'signatures', title, link: `signatures/${r.id}` },
		tenant.slug
	);
}

export async function sendRequest(m: Member, raw: Record<string, string>): Promise<Mail[]> {
	requireManage(m);
	const requestId = id('Choose a request.').parse(raw.requestId);
	const ctx = userCtx(m);
	return withTenant(ctx, async (tx) => {
		const r = await lockedRequest(tx, requestId);
		draftOnly(r);
		const list = await signersOf(tx, r.id);
		if (!list.length) throw new AppError('no_signers', 'Add at least one signer.', 400);
		if (r.offerId) {
			if (!can(m.access, 'recruitment.manage')) throw forbidden();
			await candidateEmail(tx, r.offerId);
		}
		const at = now();
		const [sent] = await tx
			.update(signatureRequests)
			.set({
				status: 'pending',
				sentAt: at,
				expiresAt: new Date(at.getTime() + r.expiresAt.getTime() - r.createdAt.getTime())
			})
			.where(eq(signatureRequests.id, r.id))
			.returning();
		await auditEvent(tx, ctx, 'signature_requests', r.id, 'sent', { signers: String(list.length) });
		return invite(tx, m.tenant, sent, list[0]);
	});
}

export async function resendInvite(m: Member, raw: Record<string, string>): Promise<Mail[]> {
	requireManage(m);
	const requestId = id('Choose a request.').parse(raw.requestId);
	const ctx = userCtx(m);
	return withTenant(ctx, async (tx) => {
		const r = await lockedRequest(tx, requestId);
		openOnly(r);
		const s = await currentSigner(tx, r.id);
		if (!s) throw new AppError('closed', 'Nobody is waiting to sign.', 409);
		await auditEvent(tx, ctx, 'signature_signers', s.id, 'invite_resent', { requestId: r.id });
		return invite(tx, m.tenant, r, s);
	});
}

export async function cancelRequest(m: Member, raw: Record<string, string>) {
	requireManage(m);
	const requestId = id('Choose a request.').parse(raw.requestId);
	const ctx = userCtx(m);
	await withTenant(ctx, async (tx) => {
		const r = await lockedRequest(tx, requestId);
		if (r.status !== 'draft' && r.status !== 'pending')
			throw new AppError('closed', 'Only a draft or open request can be cancelled.', 409);
		await tx.update(signatureRequests).set({ status: 'cancelled' }).where(eq(signatureRequests.id, r.id));
		await auditEvent(tx, ctx, 'signature_requests', r.id, 'cancelled');
	});
}

export type SignEvidence = { ip: string | null; userAgent: string };

const evidence = (e: SignEvidence) => ({
	ip: e.ip ? e.ip.slice(0, 64) : null,
	userAgent: e.userAgent.replace(CONTROLS, '').slice(0, 500)
});

export async function markSigned(
	tx: Tx,
	ctx: TenantCtx,
	tenant: SignTenant,
	r: Request,
	s: Signer,
	sig: { typedName: string; method: 'session' | 'email_otp' } & SignEvidence
): Promise<Mail[]> {
	const e = evidence(sig);
	await tx
		.update(signatureSigners)
		.set({
			status: 'signed',
			signedAt: now(),
			method: sig.method,
			typedName: sig.typedName,
			...e,
			otpHash: null,
			otpExpiresAt: null
		})
		.where(eq(signatureSigners.id, s.id));
	await auditEvent(tx, ctx, 'signature_signers', s.id, 'signed', {
		requestId: r.id,
		method: sig.method,
		sha256: r.sha256
	});
	if (s.candidate && r.offerId) await decideOfferTx(tx, { offerId: r.offerId, decision: 'accepted' });
	const next = await currentSigner(tx, r.id);
	if (next) return invite(tx, tenant, r, next);
	return complete(tx, ctx, tenant, r);
}

async function complete(tx: Tx, ctx: TenantCtx, tenant: SignTenant, r: Request): Promise<Mail[]> {
	const [s] = await tx.select({ legalName: tenantSettings.legalName }).from(tenantSettings);
	const at = now();
	const body = await renderSignatureCertificate({
		company: s?.legalName || tenant.name,
		request: { ...r, completedAt: at },
		signers: await signersOf(tx, r.id)
	});
	const key = `${r.fileKey}-certificate`;
	const certificateSha256 = hex(body);
	await putObject(key, body, 'application/pdf');
	try {
		await tx
			.update(signatureRequests)
			.set({ status: 'completed', completedAt: at, certificateKey: key, certificateSha256 })
			.where(eq(signatureRequests.id, r.id));
		await auditEvent(tx, ctx, 'signature_requests', r.id, 'completed', { certificateSha256 });
		return await tellCreator(tx, tenant, r, `Signed by everyone: ${r.title}`);
	} catch (err) {
		await deleteObject(key).catch((e) => log.error({ err: e, key }, 'orphan certificate cleanup failed'));
		throw err;
	}
}

export async function markDeclined(
	tx: Tx,
	ctx: TenantCtx,
	tenant: SignTenant,
	r: Request,
	s: Signer,
	reason: string
): Promise<Mail[]> {
	await tx
		.update(signatureSigners)
		.set({ status: 'declined', declinedAt: now(), otpHash: null, otpExpiresAt: null })
		.where(eq(signatureSigners.id, s.id));
	await tx
		.update(signatureRequests)
		.set({ status: 'declined', declineReason: reason || null })
		.where(eq(signatureRequests.id, r.id));
	await auditEvent(tx, ctx, 'signature_signers', s.id, 'declined', { requestId: r.id });
	return tellCreator(tx, tenant, r, `${s.name} declined to sign: ${r.title}`);
}

const signCtx = (m: Member): TenantCtx => ({ ...userCtx(m), actor: 'signature' });

async function myTurn(tx: Tx, m: Member, requestId: string) {
	const r = await lockedRequest(tx, requestId);
	openOnly(r);
	const s = await currentSigner(tx, r.id);
	if (!s?.employeeId || s.employeeId !== m.access.employeeId)
		throw new AppError('not_your_turn', 'This document is not waiting for your signature.', 409);
	return { r, s };
}

export async function signInternal(m: Member, raw: Record<string, string>, e: SignEvidence): Promise<Mail[]> {
	const input = signSchema.parse(raw);
	await requireRecentAuth(m.user.sessionId, API_REAUTH_MINUTES);
	const ctx = signCtx(m);
	return withTenant(ctx, async (tx) => {
		const { r, s } = await myTurn(tx, m, input.requestId);
		return markSigned(tx, ctx, m.tenant, r, s, { typedName: input.typedName, method: 'session', ...e });
	});
}

export async function declineInternal(m: Member, raw: Record<string, string>): Promise<Mail[]> {
	const input = declineSchema.parse(raw);
	const ctx = signCtx(m);
	return withTenant(ctx, async (tx) => {
		const { r, s } = await myTurn(tx, m, input.requestId);
		return markDeclined(tx, ctx, m.tenant, r, s, input.reason);
	});
}

export const otpMac = (signerId: string, code: string) => keyedMac(OTP_PURPOSE, `${signerId}:${code}`);

export function issueCode(s: Signer) {
	if (s.otpSends >= OTP_MAX_SENDS)
		throw new AppError('no_more_codes', 'No more codes can be sent for this link. Ask the sender for help.', 429);
	const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
	return {
		code,
		set: {
			otpHash: otpMac(s.id, code),
			otpExpiresAt: new Date(now().getTime() + ESIGN.otpMinutes * 60_000),
			otpSends: s.otpSends + 1
		}
	};
}

export function codeVerdict(s: Signer, code: string): { ok: true } | { ok: false; message: string } {
	const left = OTP_MAX_ATTEMPTS - s.otpAttempts - 1;
	if (s.otpHash && s.otpExpiresAt && s.otpExpiresAt.getTime() > now().getTime()) {
		if (keyedMacMatches(OTP_PURPOSE, s.otpHash, `${s.id}:${code}`)) return { ok: true };
		return {
			ok: false,
			message: left
				? `That code is not right. ${left} ${left === 1 ? 'try is' : 'tries are'} left.`
				: 'That code is not right and no tries are left. Ask the sender for a new request.'
		};
	}
	return { ok: false, message: 'That code has expired. Send a new code.' };
}

type ListRow = {
	id: string;
	title: string;
	status: string;
	expired: boolean;
	createdAt: Date;
	signers: number;
	signed: number;
};

const viewStatus = (r: Pick<Request, 'status' | 'expiresAt'>) => (isExpired(r) ? 'expired' : r.status);

export async function signaturesPage(m: Member) {
	const manage = can(m.access, 'signature.manage');
	const offerAccess = manage && can(m.access, 'recruitment.manage');
	return withTenant(userCtx(m), async (tx) => {
		const progress = {
			signers: sql<number>`(select count(*)::int from signature_signers ss where ss.request_id = signature_requests.id)`,
			signed: sql<number>`(select count(*)::int from signature_signers ss where ss.request_id = signature_requests.id and ss.status = 'signed')`
		};
		const shape = (rows: (Omit<ListRow, 'expired'> & { expiresAt: Date })[]) =>
			rows.map(({ expiresAt, ...r }) => ({
				...r,
				status: viewStatus({ status: r.status as Request['status'], expiresAt })
			}));
		const all = manage
			? shape(
					await tx
						.select({
							id: signatureRequests.id,
							title: signatureRequests.title,
							status: signatureRequests.status,
							expiresAt: signatureRequests.expiresAt,
							createdAt: signatureRequests.createdAt,
							...progress
						})
						.from(signatureRequests)
						.orderBy(desc(signatureRequests.createdAt))
						.limit(ESIGN.list)
				)
			: [];
		const mine = m.access.employeeId
			? (
					await tx
						.select({
							id: signatureRequests.id,
							title: signatureRequests.title,
							status: signatureRequests.status,
							expiresAt: signatureRequests.expiresAt,
							createdAt: signatureRequests.createdAt,
							myStatus: signatureSigners.status,
							invited: sql<boolean>`${signatureSigners.invitedAt} is not null`
						})
						.from(signatureSigners)
						.innerJoin(signatureRequests, eq(signatureRequests.id, signatureSigners.requestId))
						.where(and(eq(signatureSigners.employeeId, m.access.employeeId), ne(signatureRequests.status, 'draft')))
						.orderBy(desc(signatureRequests.createdAt))
						.limit(ESIGN.list)
				).map(({ expiresAt, invited, ...r }) => {
					const status = viewStatus({ status: r.status, expiresAt });
					return { ...r, status, myTurn: status === 'pending' && r.myStatus === 'waiting' && invited };
				})
			: [];
		const openOffers = offerAccess
			? await tx
					.select({ id: offers.id, candidate: candidates.fullName })
					.from(offers)
					.innerJoin(candidates, eq(candidates.id, offers.candidateId))
					.where(
						and(
							eq(offers.status, 'pending'),
							sql`not exists (select 1 from signature_requests sr where sr.offer_id = ${offers.id} and sr.status in ('draft','pending','completed'))`
						)
					)
					.orderBy(asc(candidates.fullName))
					.limit(ESIGN.list)
			: [];
		return { manage, all, mine, offers: openOffers, maxDays: ESIGN.maxDays };
	});
}

async function visibleRequest(tx: Tx, m: Member, requestId: string) {
	if (!z.uuid().safeParse(requestId).success) throw missing();
	const [r] = await tx.select().from(signatureRequests).where(eq(signatureRequests.id, requestId));
	if (!r) throw missing();
	const list = await signersOf(tx, r.id);
	const manage = can(m.access, 'signature.manage');
	const me = m.access.employeeId ? list.find((s) => s.employeeId === m.access.employeeId) : undefined;
	if (!manage && (!me || r.status === 'draft')) throw missing();
	return { r, list, manage, me };
}

export async function requestPage(m: Member, requestId: string) {
	return withTenant(userCtx(m), async (tx) => {
		const { r, list, manage, me } = await visibleRequest(tx, m, requestId);
		const current = r.status === 'pending' ? list.find((s) => s.status === 'waiting') : undefined;
		const status = viewStatus(r);
		const people = manage
			? (
					await tx.execute<{ id: string; name: string }>(sql`
						select e.id, e.full_name as name from employees e
						where e.status <> 'exited' and exists (
							select 1 from tenant_users tu where tu.employee_id = e.id
							and tu.membership_status = 'active' and tu.user_status = 'active')
						order by e.full_name limit 1000`)
				).map((p) => ({ id: p.id, name: p.name }))
			: [];
		return {
			request: {
				id: r.id,
				title: r.title,
				fileName: r.fileName,
				fileSize: r.fileSize,
				sha256: r.sha256,
				status,
				expiresAt: r.expiresAt,
				sentAt: r.sentAt,
				completedAt: r.completedAt,
				certificateSha256: r.certificateSha256,
				declineReason: manage ? r.declineReason : null,
				offer: r.offerId !== null
			},
			signers: list.map((s) => ({
				id: s.id,
				order: s.sortOrder,
				name: s.name,
				email: manage ? s.email : null,
				internal: s.employeeId !== null,
				status: s.status,
				current: s.id === current?.id,
				signedAt: s.signedAt,
				method: manage ? s.method : null,
				ip: manage ? s.ip : null,
				userAgent: manage ? s.userAgent : null,
				locked: manage ? s.otpAttempts >= OTP_MAX_ATTEMPTS : false
			})),
			manage,
			myTurn: status === 'pending' && !!me && me.id === current?.id && me.invitedAt !== null,
			people,
			maxSigners: ESIGN.signers,
			consent: CONSENT_TEXT,
			legal: LEGAL_NOTE
		};
	});
}

export async function requestFile(m: Member, requestId: string, kind: string) {
	if (kind !== 'original' && kind !== 'certificate') throw missing();
	const { r } = await withTenant(userCtx(m), (tx) => visibleRequest(tx, m, requestId));
	const key = kind === 'original' ? r.fileKey : r.certificateKey;
	if (!key) throw new AppError('not_found', 'The certificate is ready once everyone has signed.', 404);
	return {
		fileName: kind === 'original' ? r.fileName : `certificate-${r.fileName}`,
		body: await getObject(key)
	};
}

const METHOD_LABEL: Record<string, string> = {
	session: 'Signed in to the app and confirmed their password',
	email_otp: 'Opened the emailed link and entered a 6 digit code sent to this email'
};

export function renderSignatureCertificate(c: {
	company: string;
	request: Pick<Request, 'id' | 'title' | 'fileName' | 'fileSize' | 'sha256' | 'sentAt'> & { completedAt: Date };
	signers: Pick<Signer, 'sortOrder' | 'name' | 'email' | 'signedAt' | 'typedName' | 'method' | 'ip' | 'userAgent'>[];
}) {
	const { doc, done } = pdfDoc(`Certificate of completion: ${c.request.title}`);
	const x = 48;
	const width = 499;
	let y = 56;
	const line = (text: string, size = 10, gap = 4) => {
		if (y > 770) {
			doc.addPage();
			y = 56;
		}
		write(doc.fontSize(size), text, x, y, width);
		y = doc.y + gap;
	};
	line(c.company, 11, 8);
	line('Certificate of completion', 20, 12);
	line(`Document: ${c.request.title}`);
	line(`File: ${c.request.fileName} (${c.request.fileSize} bytes)`);
	line(`Request: ${c.request.id}`);
	line(`SHA-256 of the original document: ${c.request.sha256}`, 9);
	if (c.request.sentAt) line(`Sent: ${utc(c.request.sentAt)}`);
	line(`Completed: ${utc(c.request.completedAt)}`, 10, 14);
	c.signers.forEach((s, i) => {
		line(`${i + 1}. ${s.name} <${s.email}>`, 11, 4);
		line(`Signed: ${s.signedAt ? utc(s.signedAt) : 'not signed'}`);
		line(`Typed name: ${s.typedName ?? ''}`);
		line(`Verification: ${METHOD_LABEL[s.method ?? ''] ?? 'none'}`);
		line(`IP address: ${s.ip ?? 'unknown'}`);
		line(`Browser: ${s.userAgent || 'unknown'}`, 9, 12);
	});
	line(`Each signer agreed to: ${CONSENT_TEXT}`, 9);
	line(LEGAL_NOTE, 9);
	line(
		'The original document is stored unchanged next to this certificate. Compare its SHA-256 with the value above.',
		9
	);
	doc.end();
	return done;
}
