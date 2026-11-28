import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computeFunnel } from '../domain/recruitment/funnel';
import { poishaOf } from '../money';
import { zonedInstant } from './attendance-day';
import type { AttachmentRules } from './attachments';
import { discardFiles, dropFiles, filesFor } from './file-store';
import { queueFileText } from './file-text';
import { auditEvent } from './audit';
import { now } from './clock';
import { authPool } from './db';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import {
	CANDIDATE_SOURCES,
	DEFAULT_STAGES,
	MAX_DOCUMENT_BYTES,
	OFFER_DECISIONS,
	OPENING_STATUSES,
	RECOMMENDATIONS,
	candidateStageHistory,
	candidates,
	departments,
	designations,
	employees,
	interviewFeedback,
	interviews,
	jobOpenings,
	offers,
	openingSkills,
	pipelineStages,
	referralRewards,
	roles,
	skills,
	tenantSettings,
	tenants
} from './db/schema';
import { EMPLOYMENT_FIELDS, insertEmployee, PROFILE_FIELDS } from './employees';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { log } from './log';
import { notify, sendAll } from './notifications';
import { can, userCtx, type Access, type requireMember } from './rbac/access';
import { inviteMember, toActor } from './rbac/members';
import { inScope, resolveScope } from './rbac/scope';
import { sniffType } from './sniff';
import { deleteObject, getObject, putObject } from './storage';
import { systemCtx, withTenant, type TenantCtx, type Tx } from './tenancy';

const RESUME_TYPES = new Set([
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'image/png',
	'image/jpeg',
	'image/webp'
]);

const optionalId = (message: string) =>
	z.union([z.literal(''), z.uuid({ error: message })]).transform((v) => v || null);
const headcount = 'Headcount is 1 to 500.';
const bonus = 'Enter the referral bonus, up to 999999.99.';

const openingSchema = z.object({
	title: z.string().trim().min(1, 'Enter the job title.').max(120, 'Keep the job title under 120 characters.'),
	departmentId: optionalId('Choose a department.').prefault(''),
	designationId: optionalId('Choose a designation.').prefault(''),
	headcount: z.coerce.number(headcount).int(headcount).min(1, headcount).max(500, headcount),
	status: z.enum(OPENING_STATUSES, 'Choose a status.').default('open'),
	description: z.string().max(5000, 'Keep the description under 5000 characters.').default(''),
	visibility: z.enum(['none', 'internal'], 'Choose who can see the opening.').default('none'),
	referralBonus: z
		.string()
		.trim()
		.regex(/^(\d{1,6}(\.\d{1,2})?)?$/, bonus)
		.transform((v) => (v ? poishaOf(v) : 0))
		.prefault('')
});

const skillIdsSchema = z
	.string()
	.transform((v) => [...new Set(v.split(',').filter(Boolean))])
	.pipe(z.array(z.uuid('Choose skills from the catalogue.')).max(20, 'Choose up to 20 skills.'));

const tagError = 'Use up to 10 tags, each under 30 characters.';
export const candidateSchema = z.object({
	openingId: z.uuid({ error: 'Choose an opening.' }),
	fullName: z.string().trim().min(1, 'Enter the candidate name.').max(120, 'Keep the name under 120 characters.'),
	email: z
		.union([z.literal(''), z.email('Enter a valid email.').max(254, 'Enter a valid email.')])
		.transform((v) => v || null)
		.prefault(''),
	phone: z
		.string()
		.trim()
		.max(40, 'Enter a valid phone number.')
		.regex(/^([+\d][\d\s-]*)?$/, 'Enter a valid phone number.')
		.transform((v) => v || null)
		.prefault(''),
	source: z
		.enum(CANDIDATE_SOURCES, 'Choose where the candidate came from.')
		.refine((v) => v !== 'internal', 'Choose where the candidate came from.')
		.default('other'),
	tags: z
		.string()
		.default('')
		.transform((v) => [
			...new Set(
				v
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean)
			)
		])
		.pipe(z.array(z.string().max(30, tagError)).max(10, tagError)),
	notes: z.string().max(2000, 'Keep the notes under 2000 characters.').default('')
});

const moveSchema = z.object({
	candidateId: z.uuid({ error: 'Choose a candidate.' }),
	stageId: z.uuid({ error: 'Choose a stage.' }),
	note: z.string().trim().max(300, 'Keep the note under 300 characters.').default('')
});

const openingMissing = () => new AppError('not_found', 'That opening does not exist.', 404);
const candidateMissing = () => new AppError('not_found', 'That candidate does not exist.', 404);

async function assertOrgRefs(tx: Tx, input: { departmentId: string | null; designationId: string | null }) {
	if (input.departmentId) {
		const [d] = await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, input.departmentId));
		if (!d) throw new AppError('invalid_department', 'Choose a department.', 400);
	}
	if (input.designationId) {
		const [d] = await tx
			.select({ id: designations.id })
			.from(designations)
			.where(eq(designations.id, input.designationId));
		if (!d) throw new AppError('invalid_designation', 'Choose a designation.', 400);
	}
}

export async function saveOpening(ctx: TenantCtx, raw: Record<string, string>): Promise<string> {
	const openingId = raw.openingId ? z.uuid().safeParse(raw.openingId) : null;
	if (openingId && !openingId.success) throw openingMissing();
	const input = openingSchema.parse(raw);
	const skillIds = raw.skillIds === undefined ? null : skillIdsSchema.parse(raw.skillIds);
	return withTenant(ctx, async (tx) => {
		await assertOrgRefs(tx, input);
		if (skillIds?.length) {
			const found = await tx.select({ id: skills.id }).from(skills).where(inArray(skills.id, skillIds));
			if (found.length !== skillIds.length)
				throw new AppError('invalid_skill', 'Choose skills from the catalogue.', 400);
		}
		const id = openingId
			? (
					await tx
						.update(jobOpenings)
						.set(input)
						.where(eq(jobOpenings.id, openingId.data))
						.returning({ id: jobOpenings.id })
				)[0]?.id
			: await createOpening(tx, ctx, input);
		if (!id) throw openingMissing();
		if (skillIds) {
			await tx.delete(openingSkills).where(eq(openingSkills.openingId, id));
			if (skillIds.length)
				await tx
					.insert(openingSkills)
					.values(skillIds.map((skillId) => ({ tenantId: ctx.tenantId, openingId: id, skillId })));
		}
		return id;
	});
}

async function createOpening(tx: Tx, ctx: TenantCtx, input: z.infer<typeof openingSchema>) {
	const [row] = await tx
		.insert(jobOpenings)
		.values({ tenantId: ctx.tenantId, ...input, createdByUserId: ctx.userId ?? null })
		.returning({ id: jobOpenings.id });
	await tx
		.insert(pipelineStages)
		.values(DEFAULT_STAGES.map((s, i) => ({ tenantId: ctx.tenantId, openingId: row.id, sortOrder: i + 1, ...s })));
	return row.id;
}

export async function recruitmentBoard(tx: Tx) {
	const counts = tx
		.select({
			openingId: candidates.openingId,
			total: count().as('total'),
			active: sql<number>`count(*) filter (where ${pipelineStages.kind} = 'active')`.as('active')
		})
		.from(candidates)
		.innerJoin(pipelineStages, eq(pipelineStages.id, candidates.stageId))
		.groupBy(candidates.openingId)
		.as('counts');
	const openings = await tx
		.select({
			id: jobOpenings.id,
			title: jobOpenings.title,
			status: jobOpenings.status,
			headcount: jobOpenings.headcount,
			department: departments.name,
			total: sql<number>`coalesce(${counts.total}, 0)`.mapWith(Number),
			active: sql<number>`coalesce(${counts.active}, 0)`.mapWith(Number)
		})
		.from(jobOpenings)
		.leftJoin(departments, eq(departments.id, jobOpenings.departmentId))
		.leftJoin(counts, eq(counts.openingId, jobOpenings.id))
		.orderBy(sql`${jobOpenings.status} = 'closed'`, desc(jobOpenings.createdAt))
		.limit(100);
	return { openings, ...(await orgOptions(tx)) };
}

async function orgOptions(tx: Tx) {
	return {
		departments: await tx
			.select({ id: departments.id, name: departments.name })
			.from(departments)
			.orderBy(asc(departments.name)),
		designations: await tx
			.select({ id: designations.id, name: designations.name })
			.from(designations)
			.orderBy(asc(designations.name))
	};
}

export async function openingView(tx: Tx, openingId: string) {
	if (!z.uuid().safeParse(openingId).success) throw openingMissing();
	const [opening] = await tx.select().from(jobOpenings).where(eq(jobOpenings.id, openingId));
	if (!opening) throw openingMissing();
	const stages = await tx
		.select({
			id: pipelineStages.id,
			name: pipelineStages.name,
			sortOrder: pipelineStages.sortOrder,
			kind: pipelineStages.kind
		})
		.from(pipelineStages)
		.where(eq(pipelineStages.openingId, openingId))
		.orderBy(asc(pipelineStages.sortOrder));
	const people = await tx
		.select({
			id: candidates.id,
			fullName: candidates.fullName,
			stageId: candidates.stageId,
			source: candidates.source,
			tags: candidates.tags,
			createdAt: candidates.createdAt
		})
		.from(candidates)
		.where(eq(candidates.openingId, openingId))
		.orderBy(desc(candidates.createdAt));
	const funnel = computeFunnel(
		stages.map((s) => ({ id: s.id, name: s.name, sort_order: s.sortOrder })),
		people.map((p) => ({ id: p.id, current_stage_id: p.stageId }))
	);
	const chosen = await tx
		.select({ id: openingSkills.skillId })
		.from(openingSkills)
		.where(eq(openingSkills.openingId, openingId));
	return {
		opening,
		stages,
		candidates: people,
		funnel,
		skillIds: chosen.map((s) => s.id),
		skills: await tx.select({ id: skills.id, name: skills.name }).from(skills).orderBy(asc(skills.name)).limit(500),
		...(await orgOptions(tx))
	};
}

export async function addCandidate(ctx: TenantCtx, raw: Record<string, string>, file: File | null): Promise<string> {
	const input = candidateSchema.parse(raw);
	let resume: { key: string; name: string; type: string; size: number } | null = null;
	if (file && file.size > 0) {
		if (file.size > MAX_DOCUMENT_BYTES) throw new AppError('too_large', 'Resumes can be at most 10 MB.', 413);
		const bytes = new Uint8Array(await file.arrayBuffer());
		const type = sniffType(bytes, file.name);
		if (!type || !RESUME_TYPES.has(type))
			throw new AppError('unsupported_file', 'Upload the resume as a PDF, Word file or image.', 415);
		await withTenant(ctx, (tx) => openStage(tx, input.openingId));
		resume = {
			key: `t/${ctx.tenantId}/resumes/${randomUUID()}`,
			name: file.name.slice(0, 200) || 'resume',
			type,
			size: bytes.byteLength
		};
		await putObject(resume.key, bytes, type);
	}
	try {
		const id = await withTenant(ctx, async (tx) => {
			const stageId = await openStage(tx, input.openingId);
			const [row] = await tx
				.insert(candidates)
				.values({
					tenantId: ctx.tenantId,
					...input,
					stageId,
					resumeKey: resume?.key ?? null,
					resumeName: resume?.name ?? null,
					resumeType: resume?.type ?? null,
					resumeSize: resume?.size ?? null,
					createdByUserId: ctx.userId ?? null
				})
				.returning({ id: candidates.id });
			await tx.insert(candidateStageHistory).values({
				tenantId: ctx.tenantId,
				candidateId: row.id,
				toStageId: stageId,
				movedByUserId: ctx.userId ?? null
			});
			return row.id;
		});
		if (resume) await queueFileText({ tenantId: ctx.tenantId, candidateId: id });
		return id;
	} catch (err) {
		if (resume) {
			const key = resume.key;
			await deleteObject(key).catch((e) => log.error({ err: e, key }, 'orphan resume cleanup failed'));
		}
		if (pgCode(err) === UNIQUE_VIOLATION)
			throw new AppError('duplicate', 'That email is already a candidate for this opening.', 409);
		throw err;
	}
}

export async function openStage(tx: Tx, openingId: string) {
	const [opening] = await tx
		.select({ status: jobOpenings.status })
		.from(jobOpenings)
		.where(eq(jobOpenings.id, openingId));
	if (!opening) throw openingMissing();
	if (opening.status !== 'open') throw new AppError('not_open', 'This opening is not taking candidates.', 409);
	const [first] = await tx
		.select({ id: pipelineStages.id })
		.from(pipelineStages)
		.where(and(eq(pipelineStages.openingId, openingId), eq(pipelineStages.kind, 'active')))
		.orderBy(asc(pipelineStages.sortOrder))
		.limit(1);
	if (!first) throw new AppError('no_stage', 'This opening has no stage to start in.', 409);
	return first.id;
}

export async function moveCandidate(ctx: TenantCtx, raw: Record<string, string>) {
	const input = moveSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const [c] = await tx
			.select({
				id: candidates.id,
				openingId: candidates.openingId,
				stageId: candidates.stageId,
				employeeId: candidates.employeeId,
				stageKind: pipelineStages.kind
			})
			.from(candidates)
			.innerJoin(pipelineStages, eq(pipelineStages.id, candidates.stageId))
			.where(eq(candidates.id, input.candidateId))
			.for('update', { of: candidates });
		if (!c) throw candidateMissing();
		const [stage] = await tx
			.select({ id: pipelineStages.id, kind: pipelineStages.kind })
			.from(pipelineStages)
			.where(and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.openingId, c.openingId)));
		if (!stage) throw new AppError('invalid_stage', 'Choose a stage of this opening.', 400);
		if (c.employeeId || c.stageKind === 'hired') throw new AppError('hired', 'This candidate is already hired.', 409);
		if (stage.id === c.stageId) throw new AppError('same_stage', 'The candidate is already in that stage.', 409);
		if (stage.kind === 'hired') throw new AppError('use_hire', 'Use Hire to move a candidate to Hired.', 409);
		const [opening] = await tx
			.select({ status: jobOpenings.status })
			.from(jobOpenings)
			.where(eq(jobOpenings.id, c.openingId));
		if (opening.status === 'closed' && stage.kind !== 'rejected')
			throw new AppError('closed', 'Reopen the opening before moving candidates forward.', 409);
		await tx.update(candidates).set({ stageId: stage.id }).where(eq(candidates.id, c.id));
		await tx.insert(candidateStageHistory).values({
			tenantId: ctx.tenantId,
			candidateId: c.id,
			fromStageId: c.stageId,
			toStageId: stage.id,
			movedByUserId: ctx.userId ?? null,
			note: input.note
		});
	});
}

export async function candidateView(tx: Tx, candidateId: string, viewerMembershipId: string | null = null) {
	if (!z.uuid().safeParse(candidateId).success) throw candidateMissing();
	const [c] = await tx.select().from(candidates).where(eq(candidates.id, candidateId));
	if (!c) throw candidateMissing();
	const [opening] = await tx
		.select({ id: jobOpenings.id, title: jobOpenings.title, status: jobOpenings.status })
		.from(jobOpenings)
		.where(eq(jobOpenings.id, c.openingId));
	const stages = await tx
		.select({ id: pipelineStages.id, name: pipelineStages.name, kind: pipelineStages.kind })
		.from(pipelineStages)
		.where(eq(pipelineStages.openingId, c.openingId))
		.orderBy(asc(pipelineStages.sortOrder));
	const history = await tx
		.select({
			fromStageId: candidateStageHistory.fromStageId,
			toStageId: candidateStageHistory.toStageId,
			note: candidateStageHistory.note,
			at: candidateStageHistory.createdAt
		})
		.from(candidateStageHistory)
		.where(eq(candidateStageHistory.candidateId, c.id))
		.orderBy(desc(candidateStageHistory.createdAt));
	const nameOf = (id: string | null) => stages.find((s) => s.id === id)?.name ?? null;
	const { resumeKey, ...rest } = c;
	const [referrer] = c.referredByEmployeeId
		? await tx.select({ name: employees.fullName }).from(employees).where(eq(employees.id, c.referredByEmployeeId))
		: [];
	return {
		candidate: { ...rest, hasResume: resumeKey !== null, referrer: referrer?.name ?? null },
		opening,
		stages,
		history: history.map((h) => ({ from: nameOf(h.fromStageId), to: nameOf(h.toStageId)!, note: h.note, at: h.at })),
		interviews: await candidateInterviews(tx, c.id, viewerMembershipId),
		offers: await tx
			.select({
				id: offers.id,
				monthlyGross: offers.monthlyGross,
				joinDate: offers.joinDate,
				expiresOn: offers.expiresOn,
				status: offers.status,
				note: offers.note,
				createdAt: offers.createdAt
			})
			.from(offers)
			.where(eq(offers.candidateId, c.id))
			.orderBy(desc(offers.createdAt))
	};
}

export async function candidateFiles(tx: Tx, view: Awaited<ReturnType<typeof candidateView>>) {
	const openFeedback = view.interviews.flatMap((i) => i.panel.filter((p) => p.open).map((p) => p.id));
	return {
		candidate: (await filesFor(tx, 'candidate', [view.candidate.id])).get(view.candidate.id) ?? [],
		offers: Object.fromEntries(
			await filesFor(
				tx,
				'offer',
				view.offers.map((o) => o.id)
			)
		),
		feedback: Object.fromEntries(await filesFor(tx, 'interview_feedback', openFeedback))
	};
}

export async function openResume(m: Member, candidateId: string) {
	if (!z.uuid().safeParse(candidateId).success) throw candidateMissing();
	const ctx = userCtx(m);
	const c = await withTenant(ctx, async (tx) => {
		if (!(await candidateAttachments.canRead(tx, m.access, candidateId)))
			throw new AppError('not_found', 'That resume does not exist.', 404);
		const [row] = await tx
			.select({
				id: candidates.id,
				key: candidates.resumeKey,
				name: candidates.resumeName,
				type: candidates.resumeType
			})
			.from(candidates)
			.where(eq(candidates.id, candidateId));
		if (!row?.key) throw new AppError('not_found', 'That resume does not exist.', 404);
		await auditEvent(tx, ctx, 'candidates', row.id, 'candidate.resume.download');
		return row;
	});
	return { fileName: c.name!, contentType: c.type!, body: await getObject(c.key!) };
}

type Member = ReturnType<typeof requireMember>;

const duration = 'Interviews last 15 to 480 minutes.';
const interviewSchema = z.object({
	candidateId: z.uuid({ error: 'Choose a candidate.' }),
	title: z.string().trim().min(1, 'Enter the interview title.').max(80, 'Keep the title under 80 characters.'),
	scheduledAt: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Pick the interview date and time.')
		.refine((v) => new Date(`${v}:00Z`).toISOString().startsWith(v), 'Pick the interview date and time.'),
	durationMinutes: z.coerce.number(duration).int(duration).min(15, duration).max(480, duration),
	location: z.string().trim().max(300, 'Keep the location under 300 characters.').default(''),
	interviewers: z
		.array(z.uuid({ error: 'Choose the interviewers.' }))
		.transform((ids) => [...new Set(ids)])
		.pipe(z.array(z.string()).min(1, 'Choose at least one interviewer.').max(10, 'Choose up to 10 interviewers.'))
});

const feedbackSchema = z.object({
	interviewId: z.uuid({ error: 'Choose an interview.' }),
	rating: z.coerce
		.number('Rate the candidate from 1 to 5.')
		.int('Rate the candidate from 1 to 5.')
		.min(1, 'Rate the candidate from 1 to 5.')
		.max(5, 'Rate the candidate from 1 to 5.'),
	recommendation: z.enum(RECOMMENDATIONS, 'Choose a recommendation.'),
	comments: z.string().trim().max(2000, 'Keep the comments under 2000 characters.').default('')
});

const offerSchema = z.object({
	candidateId: z.uuid({ error: 'Choose a candidate.' }),
	monthlyGross: z
		.string()
		.trim()
		.regex(/^\d{1,8}(\.\d{1,2})?$/, 'Enter the monthly gross, up to 2 decimals.')
		.transform(poishaOf)
		.refine((v) => v > 0, 'Enter the monthly gross, up to 2 decimals.'),
	joinDate: z.iso.date('Enter a valid join date.'),
	expiresOn: z
		.union([z.literal(''), z.iso.date('Enter a valid expiry date.')])
		.transform((v) => v || null)
		.prefault(''),
	note: z.string().trim().max(500, 'Keep the note under 500 characters.').default('')
});

const decisionSchema = z.object({
	offerId: z.uuid({ error: 'Choose an offer.' }),
	decision: z.enum(OFFER_DECISIONS, 'Choose what happened to the offer.')
});

async function liveCandidate(tx: Tx, candidateId: string) {
	if (!z.uuid().safeParse(candidateId).success) throw candidateMissing();
	const [c] = await tx
		.select({
			id: candidates.id,
			fullName: candidates.fullName,
			email: candidates.email,
			phone: candidates.phone,
			openingId: candidates.openingId,
			stageId: candidates.stageId,
			employeeId: candidates.employeeId,
			internalEmployeeId: candidates.internalEmployeeId,
			referredByEmployeeId: candidates.referredByEmployeeId,
			stageKind: pipelineStages.kind,
			openingStatus: jobOpenings.status
		})
		.from(candidates)
		.innerJoin(pipelineStages, eq(pipelineStages.id, candidates.stageId))
		.innerJoin(jobOpenings, eq(jobOpenings.id, candidates.openingId))
		.where(eq(candidates.id, candidateId))
		.for('update', { of: candidates });
	if (!c) throw candidateMissing();
	if (c.employeeId) throw new AppError('hired', 'This candidate is already hired.', 409);
	if (c.stageKind !== 'active')
		throw new AppError('not_active', 'Move the candidate back into the pipeline first.', 409);
	if (c.openingStatus === 'closed') throw new AppError('closed', 'Reopen the opening first.', 409);
	return c;
}

async function feedbackMembers(tx: Tx, ids?: string[]) {
	if (ids && !ids.length) return [];
	return tx.execute<{ id: string; name: string }>(sql`
		select distinct tu.membership_id as id, coalesce(tu.name, tu.email::text) as name
		from tenant_users tu
		join membership_roles mr on mr.membership_id = tu.membership_id
		join role_permissions rp on rp.role_id = mr.role_id
		where rp.permission = 'interview.feedback' and tu.membership_status = 'active'
		${ids ? sql`and tu.membership_id in ${ids}` : sql``}
		order by 2`);
}

export const interviewerChoices = (tx: Tx) => feedbackMembers(tx);

export async function scheduleInterview(
	ctx: TenantCtx,
	tenantSlug: string,
	raw: Record<string, string>,
	interviewers: string[]
) {
	const input = interviewSchema.parse({ ...raw, interviewers });
	const mails = await withTenant(ctx, async (tx) => {
		const c = await liveCandidate(tx, input.candidateId);
		const [s] = await tx.select({ tz: tenantSettings.timezone }).from(tenantSettings);
		const scheduledAt = zonedInstant(input.scheduledAt, s?.tz ?? 'UTC');
		if (scheduledAt <= now()) throw new AppError('past', 'Pick a time in the future.', 400);
		const panel = await feedbackMembers(tx, input.interviewers);
		if (panel.length !== input.interviewers.length)
			throw new AppError('invalid_interviewer', 'Choose interviewers who can give interview feedback.', 400);
		const [row] = await tx
			.insert(interviews)
			.values({
				tenantId: ctx.tenantId,
				candidateId: c.id,
				title: input.title,
				scheduledAt,
				durationMinutes: input.durationMinutes,
				location: input.location,
				createdByUserId: ctx.userId ?? null
			})
			.returning({ id: interviews.id });
		await tx
			.insert(interviewFeedback)
			.values(
				input.interviewers.map((membershipId) => ({ tenantId: ctx.tenantId, interviewId: row.id, membershipId }))
			);
		return notify(
			tx,
			ctx.tenantId,
			input.interviewers,
			{
				category: 'recruitment',
				title: `Interview: ${c.fullName} · ${input.title}`,
				body: `You are on the panel for ${c.fullName} (${input.title}) on ${input.scheduledAt.replace('T', ' ')}.`,
				link: 'recruitment/interviews'
			},
			tenantSlug
		);
	});
	await sendAll(mails);
}

export async function cancelInterview(ctx: TenantCtx, interviewId: string) {
	if (!z.uuid().safeParse(interviewId).success) throw new AppError('not_found', 'That interview does not exist.', 404);
	await withTenant(ctx, async (tx) => {
		const [i] = await tx.select().from(interviews).where(eq(interviews.id, interviewId)).for('update');
		if (!i) throw new AppError('not_found', 'That interview does not exist.', 404);
		if (i.status === 'cancelled') throw new AppError('cancelled', 'That interview is already cancelled.', 409);
		const [given] = await tx
			.select({ id: interviewFeedback.id })
			.from(interviewFeedback)
			.where(and(eq(interviewFeedback.interviewId, i.id), isNotNull(interviewFeedback.submittedAt)))
			.limit(1);
		if (given) throw new AppError('has_feedback', 'Feedback is already in, so the interview cannot be cancelled.', 409);
		await tx.update(interviews).set({ status: 'cancelled' }).where(eq(interviews.id, i.id));
	});
}

export async function submitFeedback(ctx: TenantCtx, membershipId: string, raw: Record<string, string>) {
	const input = feedbackSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const [row] = await tx
			.select({ id: interviewFeedback.id, submittedAt: interviewFeedback.submittedAt, status: interviews.status })
			.from(interviewFeedback)
			.innerJoin(interviews, eq(interviews.id, interviewFeedback.interviewId))
			.where(
				and(eq(interviewFeedback.interviewId, input.interviewId), eq(interviewFeedback.membershipId, membershipId))
			)
			.for('update', { of: interviewFeedback });
		if (!row) throw new AppError('not_found', 'That interview is not assigned to you.', 404);
		if (row.status === 'cancelled') throw new AppError('cancelled', 'That interview was cancelled.', 409);
		if (row.submittedAt) throw new AppError('already_submitted', 'You already sent feedback for this interview.', 409);
		await tx
			.update(interviewFeedback)
			.set({
				rating: input.rating,
				recommendation: input.recommendation,
				comments: input.comments,
				submittedAt: now()
			})
			.where(eq(interviewFeedback.id, row.id));
	});
}

export async function myInterviews(tx: Tx, membershipId: string) {
	return tx
		.select({
			feedbackId: interviewFeedback.id,
			interviewId: interviews.id,
			title: interviews.title,
			scheduledAt: interviews.scheduledAt,
			durationMinutes: interviews.durationMinutes,
			location: interviews.location,
			candidateId: candidates.id,
			candidateName: candidates.fullName,
			openingTitle: jobOpenings.title,
			submittedAt: interviewFeedback.submittedAt,
			rating: interviewFeedback.rating,
			recommendation: interviewFeedback.recommendation,
			comments: interviewFeedback.comments
		})
		.from(interviewFeedback)
		.innerJoin(interviews, eq(interviews.id, interviewFeedback.interviewId))
		.innerJoin(candidates, eq(candidates.id, interviews.candidateId))
		.innerJoin(jobOpenings, eq(jobOpenings.id, candidates.openingId))
		.where(and(eq(interviewFeedback.membershipId, membershipId), eq(interviews.status, 'scheduled')))
		.orderBy(sql`${interviewFeedback.submittedAt} is not null`, asc(interviews.scheduledAt))
		.limit(100);
}

const panelName = sql<string>`(select coalesce(tu.name, tu.email::text) from tenant_users tu where tu.membership_id = interview_feedback.membership_id)`;

async function candidateInterviews(tx: Tx, candidateId: string, viewer: string | null) {
	const list = await tx
		.select({
			id: interviews.id,
			title: interviews.title,
			scheduledAt: interviews.scheduledAt,
			durationMinutes: interviews.durationMinutes,
			location: interviews.location,
			status: interviews.status
		})
		.from(interviews)
		.where(eq(interviews.candidateId, candidateId))
		.orderBy(desc(interviews.scheduledAt));
	const panel = list.length
		? await tx
				.select({
					id: interviewFeedback.id,
					interviewId: interviewFeedback.interviewId,
					membershipId: interviewFeedback.membershipId,
					name: panelName,
					rating: interviewFeedback.rating,
					recommendation: interviewFeedback.recommendation,
					comments: interviewFeedback.comments,
					submittedAt: interviewFeedback.submittedAt
				})
				.from(interviewFeedback)
				.where(
					inArray(
						interviewFeedback.interviewId,
						list.map((i) => i.id)
					)
				)
				.orderBy(panelName, asc(interviewFeedback.membershipId))
		: [];
	return list.map((i) => {
		const mine = panel.filter((p) => p.interviewId === i.id);
		const allIn = mine.every((p) => p.submittedAt);
		return {
			...i,
			allIn,
			panel: mine.map((p) => {
				const open = allIn || p.membershipId === viewer;
				return {
					id: p.id,
					open,
					membershipId: p.membershipId,
					name: p.name,
					submitted: p.submittedAt !== null,
					rating: open ? p.rating : null,
					recommendation: open ? p.recommendation : null,
					comments: open ? p.comments : null
				};
			})
		};
	});
}

export async function makeOffer(ctx: TenantCtx, raw: Record<string, string>) {
	const input = offerSchema.parse(raw);
	try {
		await withTenant(ctx, async (tx) => {
			const c = await liveCandidate(tx, input.candidateId);
			const today = await tenantToday(tx);
			if (input.joinDate < today) throw new AppError('past_join', 'The join date cannot be in the past.', 400);
			if (input.expiresOn && input.expiresOn < today)
				throw new AppError('past_expiry', 'The offer cannot expire in the past.', 400);
			if (input.expiresOn && input.expiresOn > input.joinDate)
				throw new AppError('expiry_after_join', 'The offer must expire on or before the join date.', 400);
			await tx
				.insert(offers)
				.values({ tenantId: ctx.tenantId, ...input, candidateId: c.id, createdByUserId: ctx.userId ?? null });
		});
	} catch (err) {
		if (pgCode(err) === UNIQUE_VIOLATION)
			throw new AppError('offer_exists', 'This candidate already has an open offer.', 409);
		throw err;
	}
}

export async function decideOffer(ctx: TenantCtx, raw: Record<string, string>) {
	const input = decisionSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const [o] = await tx.select().from(offers).where(eq(offers.id, input.offerId)).for('update');
		if (!o) throw new AppError('not_found', 'That offer does not exist.', 404);
		if (o.status !== 'pending') throw new AppError('decided', 'This offer is already decided.', 409);
		if (input.decision === 'accepted') {
			await liveCandidate(tx, o.candidateId);
			if (o.expiresOn && o.expiresOn < (await tenantToday(tx)))
				throw new AppError('expired', 'This offer has expired.', 409);
		}
		await tx.update(offers).set({ status: input.decision, decidedAt: now() }).where(eq(offers.id, o.id));
	});
}

export async function hireCandidate(m: Member, raw: Record<string, string>) {
	if (!can(m.access, 'employee.create'))
		throw new AppError('forbidden', 'Hiring needs permission to add employees.', 403);
	const ctx = userCtx(m, { salaryAll: true });
	const hired = await withTenant(ctx, async (tx) => {
		const c = await liveCandidate(tx, raw.candidateId ?? '');
		const [opening] = await tx.select().from(jobOpenings).where(eq(jobOpenings.id, c.openingId)).for('update');
		const [offer] = await tx
			.select()
			.from(offers)
			.where(and(eq(offers.candidateId, c.id), eq(offers.status, 'accepted')));
		if (!offer) throw new AppError('no_offer', 'Record an accepted offer before hiring.', 409);
		const [filled] = await tx
			.select({ n: count() })
			.from(candidates)
			.innerJoin(pipelineStages, eq(pipelineStages.id, candidates.stageId))
			.where(and(eq(candidates.openingId, opening.id), eq(pipelineStages.kind, 'hired')));
		if (filled.n >= opening.headcount)
			throw new AppError('headcount_full', 'All positions for this opening are filled.', 409);
		const [stage] = await tx
			.select({ id: pipelineStages.id })
			.from(pipelineStages)
			.where(and(eq(pipelineStages.openingId, opening.id), eq(pipelineStages.kind, 'hired')))
			.orderBy(asc(pipelineStages.sortOrder))
			.limit(1);
		if (!stage) throw new AppError('no_stage', 'This opening has no Hired stage.', 409);
		const moved = async (employeeId: string | null) => {
			await tx.update(candidates).set({ employeeId, stageId: stage.id }).where(eq(candidates.id, c.id));
			await tx.insert(candidateStageHistory).values({
				tenantId: ctx.tenantId,
				candidateId: c.id,
				fromStageId: c.stageId,
				toStageId: stage.id,
				movedByUserId: ctx.userId ?? null,
				note: 'Hired'
			});
		};
		if (c.internalEmployeeId) {
			const [staff] = await tx
				.select({ status: employees.status })
				.from(employees)
				.where(eq(employees.id, c.internalEmployeeId));
			if (!staff || staff.status === 'exited')
				throw new AppError('left', 'This internal applicant no longer works here.', 409);
			await moved(null);
			return { employeeId: c.internalEmployeeId, email: null, roleId: null, internal: true };
		}
		const form = Object.fromEntries(
			[...Object.keys(PROFILE_FIELDS), ...Object.keys(EMPLOYMENT_FIELDS)].map((k) => [k, ''])
		);
		const employeeId = await insertEmployee(tx, ctx.tenantId, m.access, {
			...form,
			fullName: c.fullName,
			personalEmail: c.email ?? '',
			phone: c.phone ?? '',
			departmentId: opening.departmentId ?? '',
			designationId: opening.designationId ?? '',
			employmentType: 'full_time',
			joinDate: offer.joinDate,
			status: 'onboarding'
		});
		await moved(employeeId);
		if (c.referredByEmployeeId && opening.referralBonus > 0) {
			const [s] = await tx.select({ days: tenantSettings.referralQualifyDays }).from(tenantSettings);
			await tx.insert(referralRewards).values({
				tenantId: ctx.tenantId,
				candidateId: c.id,
				employeeId: c.referredByEmployeeId,
				hiredEmployeeId: employeeId,
				amount: opening.referralBonus,
				dueOn: sql`${offer.joinDate}::date + ${s?.days ?? 90}::int`
			});
		}
		const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, 'employee'));
		return { employeeId, email: c.email, roleId: role?.id ?? null, internal: false };
	});
	if (hired.internal)
		return {
			employeeId: hired.employeeId,
			invite: 'Hired. Update their department, designation and manager on their profile.'
		};
	if (raw.invite !== 'on') return { employeeId: hired.employeeId, invite: null };
	if (!can(m.access, 'user.manage'))
		return { employeeId: hired.employeeId, invite: 'Hired. Ask someone who manages users to send the invite.' };
	if (!hired.email || !hired.roleId)
		return { employeeId: hired.employeeId, invite: 'Hired. Add their email, then invite them from Users.' };
	try {
		await inviteMember(toActor(m), { email: hired.email, roleIds: [hired.roleId], employeeId: hired.employeeId });
		return { employeeId: hired.employeeId, invite: null };
	} catch (err) {
		if (err instanceof AppError)
			return { employeeId: hired.employeeId, invite: `Hired, but the invite failed: ${err.message}` };
		throw err;
	}
}

export const candidateAttachments: AttachmentRules = {
	async canRead(tx, access, id) {
		const [c] = await tx.select({ employeeId: candidates.employeeId }).from(candidates).where(eq(candidates.id, id));
		if (!c) return false;
		if (can(access, 'recruitment.read')) return true;
		return !!c.employeeId && inScope(await resolveScope(tx, access, 'document.read'), c.employeeId);
	},
	async canEdit(tx, access, id, lock) {
		if (!can(access, 'recruitment.manage')) return false;
		const q = tx.select({ id: candidates.id }).from(candidates).where(eq(candidates.id, id));
		return (lock ? await q.for('update') : await q).length > 0;
	}
};

export const offerAttachments: AttachmentRules = {
	async canRead(tx, access, id) {
		if (!can(access, 'recruitment.read')) return false;
		return (await tx.select({ id: offers.id }).from(offers).where(eq(offers.id, id))).length > 0;
	},
	async canEdit(tx, access, id, lock) {
		if (!can(access, 'recruitment.manage')) return false;
		const q = tx.select({ id: offers.id }).from(offers).where(eq(offers.id, id));
		return (lock ? await q.for('update') : await q).length > 0;
	}
};

export const feedbackAttachments: AttachmentRules = {
	async canRead(tx, access, id) {
		const [f] = await tx
			.select({ interviewId: interviewFeedback.interviewId, membershipId: interviewFeedback.membershipId })
			.from(interviewFeedback)
			.where(eq(interviewFeedback.id, id));
		if (!f) return false;
		if (f.membershipId === access.membershipId) return true;
		if (!can(access, 'recruitment.read')) return false;
		const [{ pending }] = await tx
			.select({ pending: count() })
			.from(interviewFeedback)
			.where(and(eq(interviewFeedback.interviewId, f.interviewId), isNull(interviewFeedback.submittedAt)));
		return pending === 0;
	},
	async canEdit(tx, access, id, lock) {
		const q = tx
			.select({ submittedAt: interviewFeedback.submittedAt, status: interviews.status })
			.from(interviewFeedback)
			.innerJoin(interviews, eq(interviews.id, interviewFeedback.interviewId))
			.where(and(eq(interviewFeedback.id, id), eq(interviewFeedback.membershipId, access.membershipId)));
		const [f] = lock ? await q.for('update', { of: interviewFeedback }) : await q;
		return !!f && !f.submittedAt && f.status === 'scheduled';
	}
};

export async function hiringFiles(tx: Tx, access: Access, employeeId: string) {
	const [c] = await tx
		.select({ id: candidates.id, hasResume: isNotNull(candidates.resumeKey) })
		.from(candidates)
		.where(eq(candidates.employeeId, employeeId))
		.limit(1);
	if (!c || !(await candidateAttachments.canRead(tx, access, c.id))) return null;
	return {
		candidateId: c.id,
		hasResume: c.hasResume,
		files: (await filesFor(tx, 'candidate', [c.id])).get(c.id) ?? []
	};
}

export async function purgeTenantCandidates(tenantId: string): Promise<number> {
	const { count: purged, keys } = await withTenant(systemCtx(tenantId), async (tx) => {
		const [s] = await tx.select({ days: tenantSettings.retentionCandidatesDays }).from(tenantSettings);
		const cutoff = new Date(now().getTime() - (s?.days ?? 365) * 86_400_000);
		const due = await tx
			.select({ id: candidates.id, key: candidates.resumeKey })
			.from(candidates)
			.where(
				and(
					isNull(candidates.employeeId),
					lt(candidates.updatedAt, cutoff),
					sql`exists (
						select 1 from pipeline_stages ps join job_openings jo on jo.id = ps.opening_id
						where ps.id = ${candidates.stageId}
						and ps.kind <> 'hired'
						and (ps.kind = 'rejected' or (jo.status = 'closed' and jo.updated_at < ${cutoff.toISOString()}))
					)`
				)
			)
			.for('update', { skipLocked: true });
		if (!due.length) return { count: 0, keys: [] };
		const ids = due.map((c) => c.id);
		const offerIds = await tx.select({ id: offers.id }).from(offers).where(inArray(offers.candidateId, ids));
		const feedbackIds = await tx
			.select({ id: interviewFeedback.id })
			.from(interviewFeedback)
			.innerJoin(interviews, eq(interviews.id, interviewFeedback.interviewId))
			.where(inArray(interviews.candidateId, ids));
		const attached = [
			...(await dropFiles(tx, 'candidate', ids)),
			...(await dropFiles(
				tx,
				'offer',
				offerIds.map((o) => o.id)
			)),
			...(await dropFiles(
				tx,
				'interview_feedback',
				feedbackIds.map((f) => f.id)
			))
		];
		await tx.delete(candidates).where(inArray(candidates.id, ids));
		const resumes = due.flatMap((c) => (c.key ? [{ key: c.key }] : []));
		return { count: due.length, keys: [...resumes, ...attached] };
	});
	await discardFiles(keys);
	return purged;
}

export async function purgeCandidates() {
	const list = await authPool().db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
	for (const t of list)
		await purgeTenantCandidates(t.id).catch((err) =>
			log.error({ tenantId: t.id, err: (err as Error).message }, 'candidate purge failed')
		);
}
