import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computeFunnel } from '../domain/recruitment/funnel';
import { auditEvent } from './audit';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import {
	CANDIDATE_SOURCES,
	DEFAULT_STAGES,
	MAX_DOCUMENT_BYTES,
	OPENING_STATUSES,
	candidateStageHistory,
	candidates,
	departments,
	designations,
	jobOpenings,
	pipelineStages
} from './db/schema';
import { AppError } from './errors';
import { log } from './log';
import { sniffType } from './sniff';
import { deleteObject, getObject, putObject } from './storage';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

const RESUME_TYPES = new Set([
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const optionalId = (message: string) =>
	z.union([z.literal(''), z.uuid({ error: message })]).transform((v) => v || null);
const headcount = 'Headcount is 1 to 500.';

const openingSchema = z.object({
	title: z.string().trim().min(1, 'Enter the job title.').max(120, 'Keep the job title under 120 characters.'),
	departmentId: optionalId('Choose a department.').default(''),
	designationId: optionalId('Choose a designation.').default(''),
	headcount: z.coerce.number(headcount).int(headcount).min(1, headcount).max(500, headcount),
	status: z.enum(OPENING_STATUSES, 'Choose a status.').default('open'),
	description: z.string().max(5000, 'Keep the description under 5000 characters.').default('')
});

const tagError = 'Use up to 10 tags, each under 30 characters.';
const candidateSchema = z.object({
	openingId: z.uuid({ error: 'Choose an opening.' }),
	fullName: z.string().trim().min(1, 'Enter the candidate name.').max(120, 'Keep the name under 120 characters.'),
	email: z
		.union([z.literal(''), z.email('Enter a valid email.').max(254, 'Enter a valid email.')])
		.transform((v) => v || null)
		.default(''),
	phone: z
		.string()
		.trim()
		.max(40, 'Enter a valid phone number.')
		.regex(/^([+\d][\d\s-]*)?$/, 'Enter a valid phone number.')
		.transform((v) => v || null)
		.default(''),
	source: z.enum(CANDIDATE_SOURCES, 'Choose where the candidate came from.').default('other'),
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
	return withTenant(ctx, async (tx) => {
		await assertOrgRefs(tx, input);
		if (openingId) {
			const [row] = await tx
				.update(jobOpenings)
				.set(input)
				.where(eq(jobOpenings.id, openingId.data))
				.returning({ id: jobOpenings.id });
			if (!row) throw openingMissing();
			return row.id;
		}
		const [row] = await tx
			.insert(jobOpenings)
			.values({ tenantId: ctx.tenantId, ...input, createdByUserId: ctx.userId ?? null })
			.returning({ id: jobOpenings.id });
		await tx
			.insert(pipelineStages)
			.values(DEFAULT_STAGES.map((s, i) => ({ tenantId: ctx.tenantId, openingId: row.id, sortOrder: i + 1, ...s })));
		return row.id;
	});
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
	return { opening, stages, candidates: people, funnel, ...(await orgOptions(tx)) };
}

export async function addCandidate(ctx: TenantCtx, raw: Record<string, string>, file: File | null): Promise<string> {
	const input = candidateSchema.parse(raw);
	let resume: { key: string; name: string; type: string; size: number } | null = null;
	if (file && file.size > 0) {
		if (file.size > MAX_DOCUMENT_BYTES) throw new AppError('too_large', 'Resumes can be at most 10 MB.', 413);
		const bytes = new Uint8Array(await file.arrayBuffer());
		const type = sniffType(bytes, file.name);
		if (!type || !RESUME_TYPES.has(type))
			throw new AppError('unsupported_file', 'Upload the resume as a PDF or Word file.', 415);
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
		return await withTenant(ctx, async (tx) => {
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

async function openStage(tx: Tx, openingId: string) {
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
		const [c] = await tx.select().from(candidates).where(eq(candidates.id, input.candidateId)).for('update');
		if (!c) throw candidateMissing();
		const [stage] = await tx
			.select({ id: pipelineStages.id, kind: pipelineStages.kind })
			.from(pipelineStages)
			.where(and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.openingId, c.openingId)));
		if (!stage) throw new AppError('invalid_stage', 'Choose a stage of this opening.', 400);
		if (c.employeeId) throw new AppError('hired', 'This candidate is already hired.', 409);
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

export async function candidateView(tx: Tx, candidateId: string) {
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
	return {
		candidate: { ...rest, hasResume: resumeKey !== null },
		opening,
		stages,
		history: history.map((h) => ({ from: nameOf(h.fromStageId), to: nameOf(h.toStageId)!, note: h.note, at: h.at }))
	};
}

export async function openResume(ctx: TenantCtx, candidateId: string) {
	if (!z.uuid().safeParse(candidateId).success) throw candidateMissing();
	const c = await withTenant(ctx, async (tx) => {
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
