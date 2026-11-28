import { error, fail } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { keyedMac, keyedMacMatches } from '../auth/crypto';
import { now } from '../clock';
import { authPool } from '../db';
import { pgCode, UNIQUE_VIOLATION } from '../db/errors';
import {
	candidateStageHistory,
	candidates,
	departments,
	designations,
	jobOpenings,
	tenantSettings,
	tenants
} from '../db/schema';
import { AppError } from '../errors';
import { queueFileText } from '../file-text';
import { actionError, field } from '../http/forms';
import { log } from '../log';
import { modulesOn } from '../modules';
import { hitOrLocal, overLimit } from '../ratelimit';
import { candidateSchema, openStage } from '../recruitment';
import { safeFileName, sniffType } from '../sniff';
import { deleteObject, putObject } from '../storage';
import { systemCtx, withTenant, type Tx } from '../tenancy';
import { clientIp } from '../work-sites';

export const CAREERS = {
	perIpOpeningHour: 5,
	perOpeningDay: 200,
	perTenantDay: 1000,
	minFillMs: 3000,
	maxFormAgeMs: 86_400_000,
	maxCvBytes: 5 * 1024 * 1024
} as const;

export const PUBLIC_VISIBILITIES = ['public', 'both'] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FORM_PURPOSE = 'careers-form';
const HOUR = 3_600_000;
const DAY = 86_400_000;

const notFound = () => new AppError('not_found', 'Not found', 404);

async function careersTenant(slug: string) {
	if (!SLUG.test(slug)) return null;
	const [t] = await authPool()
		.db.select({ id: tenants.id, name: tenants.name, slug: tenants.slug, status: tenants.status })
		.from(tenants)
		.where(eq(tenants.slug, slug));
	if (t?.status !== 'active') return null;
	return t;
}

async function inCareers<T>(slug: string, fn: (tx: Tx, t: { id: string; name: string }) => Promise<T>): Promise<T> {
	const t = await careersTenant(slug);
	if (!t) throw notFound();
	return withTenant(systemCtx(t.id), async (tx) => {
		if (!(await modulesOn(tx)).has('careers')) throw notFound();
		return fn(tx, t);
	});
}

const publicOpenings = (tx: Tx, where?: SQL) =>
	tx
		.select({
			id: jobOpenings.id,
			title: jobOpenings.title,
			slug: jobOpenings.publicSlug,
			description: jobOpenings.description,
			department: departments.name,
			designation: designations.name
		})
		.from(jobOpenings)
		.leftJoin(departments, eq(departments.id, jobOpenings.departmentId))
		.leftJoin(designations, eq(designations.id, jobOpenings.designationId))
		.where(and(eq(jobOpenings.status, 'open'), inArray(jobOpenings.visibility, [...PUBLIC_VISIBILITIES]), where));

export const careersPage = (slug: string) =>
	inCareers(slug, async (tx, t) => ({
		tenant: t.name,
		openings: (await publicOpenings(tx).orderBy(desc(jobOpenings.createdAt)).limit(100)).map(
			({ description: _, id: __, ...o }) => o
		)
	}));

async function jobOf(tx: Tx, jobSlug: string) {
	if (!SLUG.test(jobSlug)) throw notFound();
	const [o] = await publicOpenings(tx, eq(jobOpenings.publicSlug, jobSlug));
	if (!o) throw notFound();
	return o;
}

const formPayload = (tenantId: string, openingId: string, at: number) => `${tenantId}:${openingId}:${at}`;

export const careersJob = (slug: string, jobSlug: string) =>
	inCareers(slug, async (tx, t) => {
		const { id, ...job } = await jobOf(tx, jobSlug);
		const [s] = await tx
			.select({
				days: tenantSettings.retentionCandidatesDays,
				legalName: tenantSettings.legalName,
				address: tenantSettings.address
			})
			.from(tenantSettings);
		const at = now().getTime();
		return {
			tenant: t.name,
			job,
			retentionDays: s?.days ?? 365,
			contact: { name: s?.legalName || t.name, address: s?.address ?? null },
			formToken: `${at}.${keyedMac(FORM_PURPOSE, formPayload(t.id, id, at))}`
		};
	});

const applySchema = candidateSchema.pick({ fullName: true, phone: true }).extend({
	email: z.email('Enter a valid email.').max(254, 'Enter a valid email.'),
	consent: z.literal('on', 'Agree to how we keep your application.')
});

function humanForm(form: FormData, tenantId: string, openingId: string) {
	if (field(form, 'website')) return false;
	const [rawAt, mac] = field(form, 'formToken').split(/\.(.*)/s);
	const at = Number(rawAt);
	if (!Number.isSafeInteger(at) || !mac || !keyedMacMatches(FORM_PURPOSE, mac, formPayload(tenantId, openingId, at)))
		return false;
	const age = now().getTime() - at;
	return age >= CAREERS.minFillMs && age <= CAREERS.maxFormAgeMs;
}

export const pdfName = (name: string) => {
	const safe = safeFileName(name).slice(0, 196);
	return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
};

const busy = () =>
	new AppError('busy', 'We are receiving a lot of applications right now. Please try again later.', 429);

const limits = (tenantId: string, openingId: string, ip: string | null) =>
	[
		['careers_ip', `${openingId}:${ip ?? 'unknown'}`, CAREERS.perIpOpeningHour, HOUR],
		['careers_opening', openingId, CAREERS.perOpeningDay, DAY],
		['careers_tenant', tenantId, CAREERS.perTenantDay, DAY]
	] as const;

export async function applyPublic(
	slug: string,
	jobSlug: string,
	ip: string | null,
	body: () => Promise<FormData>
): Promise<void> {
	const t = await careersTenant(slug);
	if (!t) throw notFound();
	const ctx = systemCtx(t.id);
	const opening = await withTenant(ctx, async (tx) => {
		if (!(await modulesOn(tx)).has('careers')) throw notFound();
		return jobOf(tx, jobSlug);
	});
	const buckets = limits(t.id, opening.id, ip);
	const full = await Promise.all(buckets.map(([bucket, id, max]) => overLimit(bucket, id, max)));
	if (full.some(Boolean)) throw busy();
	const form = await body().catch(() => {
		throw new AppError('bad_form', 'Send the form again.', 400);
	});
	const count = async (list: readonly (typeof buckets)[number][]) => {
		const hits = await Promise.all(list.map(([bucket, id, max, ms]) => hitOrLocal(bucket, id, max, ms)));
		if (hits.some((h) => !h.ok)) throw busy();
	};
	await count(buckets.slice(0, 1));
	if (!humanForm(form, t.id, opening.id)) return;
	const input = applySchema.parse({
		fullName: field(form, 'fullName'),
		email: field(form, 'email'),
		phone: field(form, 'phone'),
		consent: field(form, 'consent')
	});
	const file = form.get('cv');
	if (!(file instanceof File) || !file.size) throw new AppError('no_cv', 'Attach your CV as a PDF.', 400);
	if (file.size > CAREERS.maxCvBytes) throw new AppError('too_large', 'Your CV can be at most 5 MB.', 413);
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (sniffType(bytes, file.name) !== 'application/pdf')
		throw new AppError('unsupported_file', 'Attach your CV as a PDF.', 415);
	await count(buckets.slice(1));
	const key = `t/${t.id}/resumes/${randomUUID()}`;
	await putObject(key, bytes, 'application/pdf');
	let id: string | null = null;
	try {
		id = await withTenant(ctx, async (tx) => {
			const stageId = await openStage(tx, opening.id);
			const [row] = await tx
				.insert(candidates)
				.values({
					tenantId: t.id,
					openingId: opening.id,
					stageId,
					fullName: input.fullName,
					email: input.email.toLowerCase(),
					phone: input.phone,
					source: 'website',
					resumeKey: key,
					resumeName: pdfName(file.name),
					resumeType: 'application/pdf',
					resumeSize: bytes.byteLength
				})
				.returning({ id: candidates.id });
			await tx.insert(candidateStageHistory).values({ tenantId: t.id, candidateId: row.id, toStageId: stageId });
			return row.id;
		});
	} catch (err) {
		await deleteObject(key).catch((e) => log.error({ err: e, key }, 'orphan careers cv cleanup failed'));
		if (pgCode(err) === UNIQUE_VIOLATION) return;
		if (err instanceof AppError && err.code === 'not_open') throw notFound();
		throw err;
	}
	await queueFileText({ tenantId: t.id, candidateId: id });
}

const pageError = (err: unknown): never => {
	if (err instanceof AppError) error(err.status, err.message);
	throw err;
};

export const careersPageLoad = (slug: string) => careersPage(slug).then((p) => ({ slug, ...p }), pageError);

export const careersJobLoad = (slug: string, jobSlug: string) =>
	careersJob(slug, jobSlug).then((p) => ({ slug, ...p }), pageError);

export async function careersApplyAction(
	slug: string,
	jobSlug: string,
	ip: string,
	request: Request,
	requestId: string
) {
	try {
		await applyPublic(slug, jobSlug, clientIp(ip), () => request.formData());
		return { applied: true };
	} catch (err) {
		if (err instanceof AppError && err.status === 404) error(404, err.message);
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}
