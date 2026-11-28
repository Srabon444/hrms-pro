import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { activeMemberships } from './approval-chain';
import { requireActiveMember } from './audience';
import { now } from './clock';
import { authPool } from './db';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import {
	candidateStageHistory,
	candidates,
	departments,
	designations,
	employees,
	employeeSkills,
	jobOpenings,
	openingSkills,
	pipelineStages,
	referralRewards,
	skills,
	tenants
} from './db/schema';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { log } from './log';
import type { Mail } from './mail';
import { notify, sendAll } from './notifications';
import { hitOrLocal } from './ratelimit';
import { can, userCtx, type Access, type requireMember } from './rbac/access';
import { candidateSchema, openStage } from './recruitment';
import { salaryCtx } from './salaries';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const APPLICATIONS_PER_DAY = 10;
export const REFERRALS_PER_DAY = 10;
export const BOARD_VISIBILITIES = ['internal', 'both'] as const;
const LIST_SIZE = 100;
const WORKING = ['probation', 'active'];

const openingId = z.uuid('Choose a job.');

const referSchema = candidateSchema.pick({ fullName: true, phone: true }).extend({
	openingId,
	email: z.email('Enter a valid email.').max(254, 'Enter a valid email.'),
	note: z
		.string()
		.trim()
		.max(2000, 'Keep the note under 2000 characters.')
		.refine((v) => !v.includes('\0'), 'Remove unsupported characters.')
		.prefault('')
});

const limit = async (m: Member, bucket: string, max: number) => {
	const r = await hitOrLocal(bucket, m.access.membershipId, max, 86_400_000);
	if (!r.ok) throw new AppError('too_many', 'You have reached today’s limit. Try again tomorrow.', 429);
};

async function me(tx: Tx, m: Member) {
	await requireActiveMember(tx, m.access.membershipId);
	const [e] = m.access.employeeId
		? await tx
				.select({
					id: employees.id,
					fullName: employees.fullName,
					status: employees.status,
					workEmail: employees.workEmail,
					personalEmail: employees.personalEmail,
					phone: employees.phone,
					managerId: employees.managerId
				})
				.from(employees)
				.where(eq(employees.id, m.access.employeeId))
		: [];
	if (!e || !WORKING.includes(e.status))
		throw new AppError('forbidden', 'Only current employees can use the job board.', 403);
	return e;
}

async function boardOpening(tx: Tx, id: string) {
	const [o] = await tx
		.select({ id: jobOpenings.id, title: jobOpenings.title })
		.from(jobOpenings)
		.where(
			and(
				eq(jobOpenings.id, id),
				eq(jobOpenings.status, 'open'),
				inArray(jobOpenings.visibility, [...BOARD_VISIBILITIES])
			)
		);
	if (!o) throw new AppError('not_found', 'That job is not open for applications.', 404);
	return { ...o, stageId: await openStage(tx, o.id) };
}

const duplicate = (message: string) => (err: unknown) => {
	if (pgCode(err) === UNIQUE_VIOLATION) throw new AppError('duplicate', message, 409);
	throw err;
};

async function startCandidate(
	tx: Tx,
	m: Member,
	values: Omit<typeof candidates.$inferInsert, 'tenantId' | 'stageId' | 'openingId'>,
	opening: { id: string; stageId: string },
	duplicateMessage: string
) {
	const [row] = await tx
		.insert(candidates)
		.values({
			...values,
			tenantId: m.tenant.id,
			openingId: opening.id,
			stageId: opening.stageId,
			createdByUserId: m.user.userId
		})
		.returning({ id: candidates.id })
		.catch(duplicate(duplicateMessage));
	await tx.insert(candidateStageHistory).values({
		tenantId: m.tenant.id,
		candidateId: row.id,
		toStageId: opening.stageId,
		movedByUserId: m.user.userId
	});
}

export async function applyInternal(m: Member, raw: Record<string, string>) {
	const id = openingId.parse(raw.openingId);
	let mails: Mail[] = [];
	await withTenant(userCtx(m), async (tx) => {
		const self = await me(tx, m);
		const opening = await boardOpening(tx, id);
		await startCandidate(
			tx,
			m,
			{
				fullName: self.fullName,
				email: self.workEmail ?? self.personalEmail ?? null,
				phone: self.phone,
				source: 'internal',
				internalEmployeeId: self.id
			},
			opening,
			'You already applied for this job.'
		);
		await limit(m, 'internal_apply', APPLICATIONS_PER_DAY);
		if (raw.tellManager === 'on' && self.managerId)
			mails = await notify(
				tx,
				m.tenant.id,
				await activeMemberships(tx, self.managerId),
				{ category: 'jobs', title: `${self.fullName} applied for ${opening.title}` },
				m.tenant.slug
			);
	});
	await sendAll(mails);
}

export async function referCandidate(m: Member, raw: Record<string, string>) {
	const input = referSchema.parse(raw);
	const email = input.email.toLowerCase();
	await withTenant(userCtx(m), async (tx) => {
		const self = await me(tx, m);
		if ([self.workEmail, self.personalEmail, m.user.email].some((e) => e?.toLowerCase() === email))
			throw new AppError('self', 'You cannot refer yourself.', 400);
		const [staff] = await tx
			.select({ id: employees.id })
			.from(employees)
			.where(
				sql`${employees.status} <> 'exited' and (${employees.workEmail} = ${email} or ${employees.personalEmail} = ${email})`
			)
			.limit(1);
		if (staff)
			throw new AppError('employee', 'That person already works here. Ask them to apply on the job board.', 409);
		const opening = await boardOpening(tx, input.openingId);
		await startCandidate(
			tx,
			m,
			{
				fullName: input.fullName,
				email,
				phone: input.phone,
				source: 'referral',
				notes: input.note,
				referredByEmployeeId: self.id
			},
			opening,
			'That person is already a candidate for this job.'
		);
		await limit(m, 'referral', REFERRALS_PER_DAY);
	});
}

const stageOf = { stage: pipelineStages.name, kind: pipelineStages.kind };

export async function jobBoard(tx: Tx, access: Access) {
	const employeeId = access.employeeId;
	const openings = await tx
		.select({
			id: jobOpenings.id,
			title: jobOpenings.title,
			description: jobOpenings.description,
			referralBonus: jobOpenings.referralBonus,
			department: departments.name,
			designation: designations.name
		})
		.from(jobOpenings)
		.leftJoin(departments, eq(departments.id, jobOpenings.departmentId))
		.leftJoin(designations, eq(designations.id, jobOpenings.designationId))
		.where(and(eq(jobOpenings.status, 'open'), inArray(jobOpenings.visibility, [...BOARD_VISIBILITIES])))
		.orderBy(desc(jobOpenings.createdAt))
		.limit(LIST_SIZE);
	const ids = openings.map((o) => o.id);
	const [wanted, mine, applications, referrals] = await Promise.all([
		ids.length
			? tx
					.select({ openingId: openingSkills.openingId, skillId: skills.id, name: skills.name })
					.from(openingSkills)
					.innerJoin(skills, eq(skills.id, openingSkills.skillId))
					.where(inArray(openingSkills.openingId, ids))
					.orderBy(asc(skills.name))
			: Promise.resolve([]),
		employeeId
			? tx
					.select({ skillId: employeeSkills.skillId })
					.from(employeeSkills)
					.where(eq(employeeSkills.employeeId, employeeId))
			: Promise.resolve([]),
		employeeId
			? tx
					.select({
						id: candidates.id,
						openingId: candidates.openingId,
						title: jobOpenings.title,
						...stageOf,
						at: candidates.createdAt
					})
					.from(candidates)
					.innerJoin(jobOpenings, eq(jobOpenings.id, candidates.openingId))
					.innerJoin(pipelineStages, eq(pipelineStages.id, candidates.stageId))
					.where(eq(candidates.internalEmployeeId, employeeId))
					.orderBy(desc(candidates.createdAt))
					.limit(LIST_SIZE)
			: Promise.resolve([]),
		employeeId
			? tx
					.select({
						id: candidates.id,
						name: candidates.fullName,
						title: jobOpenings.title,
						...stageOf,
						reward: referralRewards.status,
						amount: referralRewards.amount,
						at: candidates.createdAt
					})
					.from(candidates)
					.innerJoin(jobOpenings, eq(jobOpenings.id, candidates.openingId))
					.innerJoin(pipelineStages, eq(pipelineStages.id, candidates.stageId))
					.leftJoin(referralRewards, eq(referralRewards.candidateId, candidates.id))
					.where(eq(candidates.referredByEmployeeId, employeeId))
					.orderBy(desc(candidates.createdAt))
					.limit(LIST_SIZE)
			: Promise.resolve([])
	]);
	const have = new Set(mine.map((s) => s.skillId));
	const applied = new Set(applications.map((a) => a.openingId));
	return {
		openings: openings.map((o) => {
			const needs = wanted.filter((w) => w.openingId === o.id);
			return {
				...o,
				skills: needs.map((n) => ({ name: n.name, have: have.has(n.skillId) })),
				match: needs.length ? Math.round((needs.filter((n) => have.has(n.skillId)).length / needs.length) * 100) : null,
				applied: applied.has(o.id)
			};
		}),
		applications: applications.map(({ openingId: _, ...a }) => a),
		referrals
	};
}

export async function rewardList(tx: Tx) {
	return tx
		.select({
			id: referralRewards.id,
			referrer: sql<string>`(select e.full_name from employees e where e.id = ${referralRewards.employeeId})`,
			hire: sql<string>`(select e.full_name from employees e where e.id = ${referralRewards.hiredEmployeeId})`,
			amount: referralRewards.amount,
			status: referralRewards.status,
			dueOn: referralRewards.dueOn,
			paidAt: referralRewards.paidAt
		})
		.from(referralRewards)
		.orderBy(
			sql`array_position(array['due','pending','paid','void'], ${referralRewards.status})`,
			asc(referralRewards.dueOn)
		)
		.limit(200);
}

const rewardSchema = z.object({
	rewardId: z.uuid('Choose a reward.'),
	to: z.enum(['paid', 'void'], 'Choose what to do with the reward.')
});

export async function settleReward(m: Member, raw: Record<string, string>) {
	if (!can(m.access, 'salary.update')) throw new AppError('forbidden', 'You do not have permission to do that.', 403);
	const input = rewardSchema.parse(raw);
	await withTenant(salaryCtx(m), async (tx) => {
		const [r] = await tx
			.update(referralRewards)
			.set(input.to === 'paid' ? { status: 'paid', paidAt: now(), paidByUserId: m.user.userId } : { status: 'void' })
			.where(
				and(
					eq(referralRewards.id, input.rewardId),
					inArray(referralRewards.status, input.to === 'paid' ? ['due'] : ['pending', 'due'])
				)
			)
			.returning({ id: referralRewards.id });
		if (!r)
			throw new AppError(
				'not_allowed',
				input.to === 'paid' ? 'Only a due reward can be marked paid.' : 'Only a pending or due reward can be voided.',
				409
			);
	});
}

export async function settleTenantRewards(tenantId: string) {
	return withTenant({ ...systemCtx(tenantId), salaryAll: true }, async (tx) => {
		const today = await tenantToday(tx);
		const rows = await tx.execute<{ id: string }>(sql`
			update referral_rewards r
			set status = case when e.status = 'exited' or ref.status = 'exited' then 'void' else 'due' end
			from employees e, employees ref
			where e.id = r.hired_employee_id and ref.id = r.employee_id and r.status = 'pending'
				and (e.status = 'exited' or ref.status = 'exited'
					or (r.due_on <= ${today}::date and e.status in ('probation', 'active', 'notice')))
			returning r.id`);
		return rows.length;
	});
}

export async function runReferralRewards() {
	const list = await authPool().db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
	await list.reduce<Promise<void>>(
		(prior, t) =>
			prior.then(() =>
				settleTenantRewards(t.id).then(
					() => undefined,
					(err) => log.error({ tenantId: t.id, err: (err as Error).message }, 'referral rewards failed')
				)
			),
		Promise.resolve()
	);
}
