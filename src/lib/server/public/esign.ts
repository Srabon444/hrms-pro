import { error, fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { sha256 } from '../auth/crypto';
import { auditEvent } from '../audit';
import { now } from '../clock';
import { OTP_MAX_ATTEMPTS, OTP_MAX_SENDS, signatureSigners } from '../db/schema';
import {
	CONSENT_TEXT,
	codeVerdict,
	consentSchema,
	currentSigner,
	ESIGN,
	isExpired,
	issueCode,
	LEGAL_NOTE,
	lockedRequest,
	markDeclined,
	markSigned,
	reasonSchema,
	typedNameSchema,
	type SignTenant
} from '../esign';
import { AppError } from '../errors';
import { actionError, field } from '../http/forms';
import type { Mail } from '../mail';
import { modulesOn } from '../modules';
import { sendAll } from '../notifications';
import { hitOrLocal, overLimit } from '../ratelimit';
import { getObject } from '../storage';
import { withTenant, type TenantCtx, type Tx } from '../tenancy';
import { clientIp } from '../work-sites';
import { activeTenant, lookupToken } from './tokens';

export const SIGN_LIMITS = { failuresPerIpHour: 20, perTokenHour: 60 } as const;
const HOUR = 3_600_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const notFound = () => new AppError('not_found', 'This signing link is not valid.', 404);
const busy = () => new AppError('busy', 'Too many tries. Please wait an hour and try again.', 429);

type Gate = { tenant: SignTenant; signerId: string; ctx: TenantCtx };

async function gate(token: string, ip: string): Promise<Omit<Gate, 'ctx'>> {
	if (await overLimit('esign-fail', ip, SIGN_LIMITS.failuresPerIpHour)) throw busy();
	const failed = async () => {
		await hitOrLocal('esign-fail', ip, SIGN_LIMITS.failuresPerIpHour, HOUR);
		return notFound();
	};
	if (!TOKEN.test(token)) throw await failed();
	const hash = sha256(token);
	const perToken = await hitOrLocal('esign-token', hash, SIGN_LIMITS.perTokenHour, HOUR);
	if (!perToken.ok) throw busy();
	const found = await lookupToken('signature_signer', hash);
	const t = found ? await activeTenant(found.tenantId) : null;
	if (!found || !t) throw await failed();
	return { tenant: { id: found.tenantId, name: t.name, slug: t.slug }, signerId: found.id };
}

async function inSigning<T>(token: string, ip: string, fn: (tx: Tx, g: Gate) => Promise<T>): Promise<T> {
	const g = await gate(token, ip);
	const ctx: TenantCtx = { tenantId: g.tenant.id, actor: 'signature' };
	return withTenant(ctx, async (tx) => {
		if (!(await modulesOn(tx)).has('esign')) throw notFound();
		return fn(tx, { ...g, ctx });
	});
}

async function pair(tx: Tx, signerId: string) {
	const [first] = await tx
		.select({ requestId: signatureSigners.requestId })
		.from(signatureSigners)
		.where(eq(signatureSigners.id, signerId));
	if (!first) throw notFound();
	const r = await lockedRequest(tx, first.requestId);
	const [s] = await tx.select().from(signatureSigners).where(eq(signatureSigners.id, signerId)).for('update');
	const current = await currentSigner(tx, r.id);
	const state =
		s.status !== 'waiting'
			? s.status
			: r.status !== 'pending'
				? 'closed'
				: isExpired(r)
					? 'expired'
					: current?.id !== s.id
						? 'waiting'
						: s.otpAttempts >= OTP_MAX_ATTEMPTS
							? 'locked'
							: 'ready';
	return { r, s, state };
}

const STATE_MESSAGE: Record<string, string> = {
	signed: 'You already signed this document.',
	declined: 'You declined to sign this document.',
	closed: 'This request is no longer open for signing.',
	expired: 'This request has expired.',
	waiting: 'This document is not waiting for your signature yet.',
	locked: 'Too many wrong codes. Ask the sender for a new request.'
};

const requireReady = (state: string) => {
	if (state !== 'ready') throw new AppError(state, STATE_MESSAGE[state] ?? STATE_MESSAGE.closed, 409);
};

export const signView = (token: string, ip: string) =>
	inSigning(token, ip, async (tx, g) => {
		const { r, s, state } = await pair(tx, g.signerId);
		const at = now().getTime();
		return {
			tenant: g.tenant.name,
			title: r.title,
			fileName: r.fileName,
			fileSize: r.fileSize,
			sha256: r.sha256,
			name: s.name,
			email: s.email,
			state,
			message: STATE_MESSAGE[state] ?? null,
			expiresAt: r.expiresAt.toISOString(),
			codeSent: !!s.otpExpiresAt && s.otpExpiresAt.getTime() > at,
			sendsLeft: OTP_MAX_SENDS - s.otpSends,
			attemptsLeft: OTP_MAX_ATTEMPTS - s.otpAttempts,
			otpMinutes: ESIGN.otpMinutes,
			consent: CONSENT_TEXT,
			legal: LEGAL_NOTE
		};
	});

export const signDocument = (token: string, ip: string) =>
	inSigning(token, ip, async (tx, g) => {
		const { r, s, state } = await pair(tx, g.signerId);
		const live = (r.status === 'pending' && !isExpired(r)) || r.status === 'completed';
		if (!live || (state !== 'ready' && s.status !== 'signed')) throw notFound();
		return { fileName: r.fileName, key: r.fileKey };
	}).then(async (f) => ({ fileName: f.fileName, body: await getObject(f.key) }));

const maskEmail = (email: string) => email.replace(/^(.)[^@]*(@.*)$/, '$1***$2');

export async function sendCode(token: string, ip: string): Promise<string> {
	const out = await inSigning(token, ip, async (tx, g) => {
		const { r, s, state } = await pair(tx, g.signerId);
		requireReady(state);
		const { code, set } = issueCode(s);
		await tx.update(signatureSigners).set(set).where(eq(signatureSigners.id, s.id));
		await auditEvent(tx, g.ctx, 'signature_signers', s.id, 'code_sent', { requestId: r.id });
		const mail: Mail = {
			to: s.email,
			subject: `Your signing code for ${r.title}`,
			tenantId: g.tenant.id,
			text: `Your code is ${code}. It works for ${ESIGN.otpMinutes} minutes.\n\nIf you did not ask to sign "${r.title}", ignore this email.`
		};
		return { mail, to: maskEmail(s.email) };
	});
	await sendAll([out.mail]);
	return out.to;
}

const codeSchema = z
	.string()
	.trim()
	.regex(/^\d{6}$/, 'Enter the 6 digit code from the email.');

const signSchema = z.object({ code: codeSchema, typedName: typedNameSchema, consent: consentSchema });
const declineSchema = z.object({ code: codeSchema, reason: reasonSchema });

type Outcome = { ok: true; mails: Mail[] } | { ok: false; message: string };

async function withCode(
	token: string,
	ip: string,
	code: string,
	then: (tx: Tx, g: Gate, p: Awaited<ReturnType<typeof pair>>) => Promise<Mail[]>
) {
	const out = await inSigning<Outcome>(token, ip, async (tx, g) => {
		const p = await pair(tx, g.signerId);
		requireReady(p.state);
		if (!p.s.otpHash) throw new AppError('no_code', 'Email yourself a code first.', 400);
		const verdict = codeVerdict(p.s, code);
		const attempts = p.s.otpAttempts + 1;
		await tx.update(signatureSigners).set({ otpAttempts: attempts }).where(eq(signatureSigners.id, p.s.id));
		if (!verdict.ok) {
			await auditEvent(tx, g.ctx, 'signature_signers', p.s.id, 'code_failed', {
				requestId: p.r.id,
				attempts: String(attempts)
			});
			return verdict;
		}
		return { ok: true, mails: await then(tx, g, { ...p, s: { ...p.s, otpAttempts: attempts } }) };
	});
	if (!out.ok) throw new AppError('wrong_code', out.message, 400);
	await sendAll(out.mails);
}

export async function signExternal(token: string, ip: string, userAgent: string, form: FormData) {
	const input = signSchema.parse({
		code: field(form, 'code'),
		typedName: field(form, 'typedName'),
		consent: field(form, 'consent')
	});
	await withCode(token, ip, input.code, (tx, g, { r, s }) =>
		markSigned(tx, g.ctx, g.tenant, r, s, { typedName: input.typedName, method: 'email_otp', ip, userAgent })
	);
}

export async function declineExternal(token: string, ip: string, form: FormData) {
	const input = declineSchema.parse({ code: field(form, 'code'), reason: field(form, 'reason') });
	await withCode(token, ip, input.code, (tx, g, { r, s }) => markDeclined(tx, g.ctx, g.tenant, r, s, input.reason));
}

const pageError = (err: unknown): never => {
	if (err instanceof AppError) error(err.status, err.message);
	throw err;
};

export const signPageLoad = (token: string, ip: string) => signView(token, clientIp(ip) ?? 'unknown').catch(pageError);

export async function signDocumentResponse(token: string, ip: string) {
	try {
		const f = await signDocument(token, clientIp(ip) ?? 'unknown');
		return new Response(new Uint8Array(f.body), {
			headers: {
				'content-type': 'application/pdf',
				'content-length': String(f.body.byteLength),
				'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
				'x-content-type-options': 'nosniff',
				'cache-control': 'private, no-store',
				'referrer-policy': 'no-referrer',
				'x-robots-tag': 'noindex'
			}
		});
	} catch (err) {
		return pageError(err);
	}
}

async function act<T>(run: () => Promise<T>, requestId: string) {
	try {
		return await run();
	} catch (err) {
		if (err instanceof AppError && err.status === 404) error(404, err.message);
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

export const signActions = {
	code: (token: string, ip: string, requestId: string) =>
		act(async () => ({ sent: await sendCode(token, clientIp(ip) ?? 'unknown') }), requestId),
	sign: (token: string, ip: string, userAgent: string, request: Request, requestId: string) =>
		act(async () => {
			await signExternal(token, clientIp(ip) ?? 'unknown', userAgent, await request.formData());
			return { signed: true };
		}, requestId),
	decline: (token: string, ip: string, request: Request, requestId: string) =>
		act(async () => {
			await declineExternal(token, clientIp(ip) ?? 'unknown', await request.formData());
			return { declined: true };
		}, requestId)
};
