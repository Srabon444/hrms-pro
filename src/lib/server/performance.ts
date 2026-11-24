import { and, asc, count, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { weightedScore } from '../domain/performance/score';
import { activeMemberships, activeMembershipsOf } from './approval-chain';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { employees, goals, MAX_GOALS, reviewCycles, reviews } from './db/schema';
import type { AttachmentRules } from './attachments';
import { AppError } from './errors';
import { discardFiles, dropFiles } from './file-store';
import { notify } from './notifications';
import { can, scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Need = 'goals' | 'self' | 'manager' | 'finalise' | 'share';

export const REVIEW_PAGE_SIZE = 100;
const REVIEWABLE = ['probation', 'active', 'notice'];
const ratingError = (who: string) => `Rate ${who} from 1 to 5 on every goal.`;
const rating = (who: string) =>
	z.coerce.number(ratingError(who)).int(ratingError(who)).min(1, ratingError(who)).max(5, ratingError(who));
const comments = z.string().trim().max(4000, 'Keep the comments under 4000 characters.').prefault('');
const reviewId = z.uuid({ error: 'Choose a review.' });

const cycleSchema = z
	.object({
		name: z.string().trim().min(1, 'Name the review cycle.').max(80, 'Keep the name under 80 characters.'),
		periodStart: z.iso.date('Choose when the period starts.'),
		periodEnd: z.iso.date('Choose when the period ends.')
	})
	.refine((v) => v.periodEnd >= v.periodStart, 'The period must end on or after its start.');

const weightError = 'Give the goal a weight from 1 to 100.';
const goalSchema = z.object({
	reviewId,
	goalId: z
		.union([z.literal(''), z.uuid({ error: 'Choose a goal.' })])
		.transform((v) => v || null)
		.prefault(''),
	title: z.string().trim().min(1, 'Name the goal.').max(120, 'Keep the goal under 120 characters.'),
	target: z.string().trim().max(200, 'Keep the target under 200 characters.').prefault(''),
	weight: z.coerce.number(weightError).int(weightError).min(1, weightError).max(100, weightError)
});

const notFound = () => new AppError('not_found', 'That review does not exist.', 404);
const refusal: Record<Need, string> = {
	goals: 'Goals can only change before the self review is sent.',
	self: 'This self review is not waiting for you.',
	manager: 'This review is not waiting for your rating.',
	finalise: 'This review is not waiting to be finalised.',
	share: 'This review cannot be shared now.'
};

const onlyHr = (access: Access) => {
	if (!scopesOf(access, 'performance.manage').includes('all'))
		throw new AppError('forbidden', 'Only HR can run review cycles.', 403);
};

export async function createCycle(m: Member, raw: Record<string, string>) {
	const input = cycleSchema.parse(raw);
	onlyHr(m.access);
	return withTenant(userCtx(m), async (tx) => {
		const [cycle] = await tx
			.insert(reviewCycles)
			.values({ tenantId: m.tenant.id, ...input, createdByUserId: m.user.userId })
			.returning({ id: reviewCycles.id })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('cycle_exists', 'A review cycle with that name already exists.', 409);
				throw err;
			});
		const people = await tx.select({ id: employees.id }).from(employees).where(inArray(employees.status, REVIEWABLE));
		if (!people.length) return { cycleId: cycle.id, mails: [] };
		const ids = people.map((p) => p.id);
		await tx
			.insert(reviews)
			.values(ids.map((employeeId) => ({ tenantId: m.tenant.id, cycleId: cycle.id, employeeId })));
		const mails = await notify(
			tx,
			m.tenant.id,
			await activeMembershipsOf(tx, ids),
			{
				category: 'performance',
				title: `Performance review: ${input.name}`,
				body: 'Add your goals and send your self review.',
				link: 'performance'
			},
			m.tenant.slug
		);
		return { cycleId: cycle.id, mails };
	});
}

export async function closeCycle(m: Member, raw: Record<string, string>) {
	const id = z.uuid({ error: 'Choose a review cycle.' }).parse(raw.cycleId);
	onlyHr(m.access);
	await withTenant(userCtx(m), async (tx) => {
		const [c] = await tx.select().from(reviewCycles).where(eq(reviewCycles.id, id)).for('update');
		if (!c) throw new AppError('not_found', 'That review cycle does not exist.', 404);
		if (c.status === 'closed') throw new AppError('closed', 'That review cycle is already closed.', 409);
		await tx.update(reviewCycles).set({ status: 'closed' }).where(eq(reviewCycles.id, id));
	});
}

const listFields = {
	id: reviews.id,
	stage: reviews.stage,
	cycle: reviewCycles.name,
	name: employees.fullName,
	code: employees.code
};

const listed = (tx: Tx, where: SQL | undefined) =>
	tx
		.select(listFields)
		.from(reviews)
		.innerJoin(reviewCycles, eq(reviewCycles.id, reviews.cycleId))
		.innerJoin(employees, eq(employees.id, reviews.employeeId))
		.where(where)
		.orderBy(desc(reviewCycles.periodStart), asc(employees.fullName))
		.limit(REVIEW_PAGE_SIZE);

async function waitingOn(
	tx: Tx,
	access: Access,
	permission: 'performance.review' | 'performance.manage',
	stage: string
) {
	if (!can(access, permission)) return [];
	const me = access.employeeId;
	return listed(
		tx,
		and(
			eq(reviews.stage, stage),
			eq(reviewCycles.status, 'open'),
			scopeWhere(await resolveScope(tx, access, permission), reviews.employeeId),
			me ? ne(reviews.employeeId, me) : undefined
		)
	);
}

export async function performanceHome(tx: Tx, access: Access) {
	const me = access.employeeId;
	return {
		cycles: await tx.select().from(reviewCycles).orderBy(desc(reviewCycles.periodStart), asc(reviewCycles.name)),
		mine: me ? await listed(tx, eq(reviews.employeeId, me)) : [],
		toReview: await waitingOn(tx, access, 'performance.review', 'manager'),
		toFinalise: await waitingOn(tx, access, 'performance.manage', 'hr')
	};
}

export async function cycleView(tx: Tx, access: Access, cycleId: string, page: number) {
	if (!z.uuid().safeParse(cycleId).success) return null;
	const [cycle] = await tx.select().from(reviewCycles).where(eq(reviewCycles.id, cycleId));
	if (!cycle) return null;
	const where = and(
		eq(reviews.cycleId, cycleId),
		scopeWhere(await resolveScope(tx, access, 'performance.read'), reviews.employeeId)
	);
	const rows = await tx
		.select({ ...listFields, employeeId: reviews.employeeId, score: reviews.score, shared: reviews.shared })
		.from(reviews)
		.innerJoin(reviewCycles, eq(reviewCycles.id, reviews.cycleId))
		.innerJoin(employees, eq(employees.id, reviews.employeeId))
		.where(where)
		.orderBy(asc(employees.fullName), asc(reviews.id))
		.limit(REVIEW_PAGE_SIZE)
		.offset((page - 1) * REVIEW_PAGE_SIZE);
	const [{ total }] = await tx.select({ total: count() }).from(reviews).where(where);
	return {
		cycle,
		rows: rows.map(({ employeeId, ...r }) => ({
			...r,
			score: employeeId === access.employeeId && !r.shared ? null : r.score
		})),
		page,
		pages: Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE)),
		canClose: cycle.status === 'open' && scopesOf(access, 'performance.manage').includes('all')
	};
}

async function loadReview(tx: Tx, access: Access, id: string, lock = false) {
	const q = tx
		.select({
			review: reviews,
			cycleName: reviewCycles.name,
			cycleOpen: sql<boolean>`${reviewCycles.status} = 'open'`,
			name: employees.fullName,
			managerId: employees.managerId
		})
		.from(reviews)
		.innerJoin(reviewCycles, eq(reviewCycles.id, reviews.cycleId))
		.innerJoin(employees, eq(employees.id, reviews.employeeId))
		.where(eq(reviews.id, id));
	const [r] = lock ? await q.for('update', { of: reviews }) : await q;
	if (!r) return null;
	const employeeId = r.review.employeeId;
	const own = access.employeeId === employeeId;
	const read = own || inScope(await resolveScope(tx, access, 'performance.read'), employeeId);
	const reviewer = !own && inScope(await resolveScope(tx, access, 'performance.review'), employeeId);
	const hr = !own && inScope(await resolveScope(tx, access, 'performance.manage'), employeeId);
	if (!read && !reviewer && !hr) return null;
	const { stage, shared } = r.review;
	const open = r.cycleOpen;
	const allowed: Record<Need, boolean> = {
		goals: open && stage === 'self' && (own || reviewer),
		self: open && stage === 'self' && own,
		manager: open && stage === 'manager' && reviewer,
		finalise: open && stage === 'hr' && hr,
		share: stage === 'done' && !shared && hr
	};
	return { ...r, own, allowed };
}

async function editable(tx: Tx, access: Access, id: string, need: Need) {
	const r = await loadReview(tx, access, id, true);
	if (!r) throw notFound();
	if (!r.cycleOpen && need !== 'share') throw new AppError('closed', 'This review cycle is closed.', 409);
	if (!r.allowed[need]) throw new AppError('not_allowed', refusal[need], 409);
	return r;
}

const goalsOf = (tx: Tx, id: string) =>
	tx.select().from(goals).where(eq(goals.reviewId, id)).orderBy(asc(goals.createdAt), asc(goals.id));

export async function reviewView(tx: Tx, access: Access, id: string) {
	if (!z.uuid().safeParse(id).success) return null;
	const r = await loadReview(tx, access, id);
	if (!r) return null;
	const { review } = r;
	const showManager = !r.own || review.shared;
	return {
		review: {
			id: review.id,
			cycleId: review.cycleId,
			cycleName: r.cycleName,
			cycleOpen: r.cycleOpen,
			employeeId: review.employeeId,
			name: r.name,
			stage: review.stage,
			shared: review.shared,
			own: r.own,
			selfComments: review.selfComments,
			managerComments: showManager ? review.managerComments : '',
			score: showManager ? review.score : null
		},
		goals: (await goalsOf(tx, id)).map((g) => ({
			id: g.id,
			title: g.title,
			target: g.target,
			weight: g.weight,
			actual: g.actual,
			selfRating: g.selfRating,
			managerRating: showManager ? g.managerRating : null
		})),
		allowed: r.allowed
	};
}

export async function saveGoal(m: Member, raw: Record<string, string>) {
	const input = goalSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		await editable(tx, m.access, input.reviewId, 'goals');
		const list = await goalsOf(tx, input.reviewId);
		if (input.goalId && !list.some((g) => g.id === input.goalId))
			throw new AppError('not_found', 'That goal does not exist.', 404);
		if (!input.goalId && list.length >= MAX_GOALS)
			throw new AppError('too_many', `Keep it to ${MAX_GOALS} goals.`, 409);
		const others = list.filter((g) => g.id !== input.goalId).reduce((sum, g) => sum + g.weight, 0);
		if (others + input.weight > 100)
			throw new AppError('overweight', `Goal weights cannot add up to more than 100. ${100 - others} is left.`, 400);
		const values = { title: input.title, target: input.target, weight: input.weight };
		if (input.goalId) await tx.update(goals).set(values).where(eq(goals.id, input.goalId));
		else await tx.insert(goals).values({ tenantId: m.tenant.id, reviewId: input.reviewId, ...values });
	});
}

export async function removeGoal(m: Member, raw: Record<string, string>) {
	const input = z.object({ reviewId, goalId: z.uuid({ error: 'Choose a goal.' }) }).parse(raw);
	const stored = await withTenant(userCtx(m), async (tx) => {
		await editable(tx, m.access, input.reviewId, 'goals');
		const gone = await tx
			.delete(goals)
			.where(and(eq(goals.id, input.goalId), eq(goals.reviewId, input.reviewId)))
			.returning({ id: goals.id });
		if (!gone.length) throw new AppError('not_found', 'That goal does not exist.', 404);
		return dropFiles(tx, 'goal', [input.goalId]);
	});
	await discardFiles(stored);
}

export const reviewAttachments: AttachmentRules = {
	canRead: async (tx, access, id) => (await loadReview(tx, access, id)) !== null,
	async canEdit(tx, access, id, lock) {
		const r = await loadReview(tx, access, id, lock);
		return !!r && (r.allowed.self || r.allowed.manager);
	}
};

async function goalReview(tx: Tx, access: Access, id: string, lock = false) {
	const [g] = await tx.select({ reviewId: goals.reviewId }).from(goals).where(eq(goals.id, id));
	return g ? loadReview(tx, access, g.reviewId, lock) : null;
}

export const goalAttachments: AttachmentRules = {
	canRead: async (tx, access, id) => (await goalReview(tx, access, id)) !== null,
	canEdit: async (tx, access, id, lock) => (await goalReview(tx, access, id, lock))?.allowed.goals ?? false
};

const caseOf = (column: PgColumn, values: Map<string, SQL>) =>
	sql`case ${goals.id} ${sql.join(
		[...values].map(([id, v]) => sql`when ${id}::uuid then ${v}`),
		sql` `
	)} else ${column} end`;

export async function submitSelf(m: Member, raw: Record<string, string>) {
	const id = reviewId.parse(raw.reviewId);
	const note = comments.parse(raw.comments);
	return withTenant(userCtx(m), async (tx) => {
		const r = await editable(tx, m.access, id, 'self');
		const list = await goalsOf(tx, id);
		if (!list.length) throw new AppError('no_goals', 'Add at least one goal first.', 400);
		if (list.reduce((sum, g) => sum + g.weight, 0) !== 100)
			throw new AppError('weights', 'Goal weights must add up to 100.', 400);
		const actual = z.string().trim().max(200, 'Keep each result under 200 characters.').prefault('');
		const parsed = list.map((g) => ({
			id: g.id,
			actual: actual.parse(raw[`actual.${g.id}`]),
			rating: rating('yourself').parse(raw[`rating.${g.id}`])
		}));
		await tx
			.update(goals)
			.set({
				actual: caseOf(goals.actual, new Map(parsed.map((p) => [p.id, sql`${p.actual}`]))),
				selfRating: caseOf(goals.selfRating, new Map(parsed.map((p) => [p.id, sql`${p.rating}::smallint`])))
			})
			.where(eq(goals.reviewId, id));
		await tx
			.update(reviews)
			.set({ stage: 'manager', selfComments: note, selfSubmittedAt: new Date() })
			.where(eq(reviews.id, id));
		return notify(
			tx,
			m.tenant.id,
			await activeMemberships(tx, r.managerId),
			{
				category: 'performance',
				title: `Self review sent: ${r.name}`,
				body: `${r.cycleName} is waiting for your rating.`,
				link: `performance/reviews/${id}`
			},
			m.tenant.slug
		);
	});
}

export async function submitManager(m: Member, raw: Record<string, string>) {
	const id = reviewId.parse(raw.reviewId);
	const note = comments.parse(raw.comments);
	await withTenant(userCtx(m), async (tx) => {
		await editable(tx, m.access, id, 'manager');
		const list = await goalsOf(tx, id);
		const rated = list.map((g) => ({
			id: g.id,
			weight: g.weight,
			rating: rating('the employee').parse(raw[`rating.${g.id}`])
		}));
		await tx
			.update(goals)
			.set({
				managerRating: caseOf(goals.managerRating, new Map(rated.map((g) => [g.id, sql`${g.rating}::smallint`])))
			})
			.where(eq(goals.reviewId, id));
		await tx
			.update(reviews)
			.set({
				stage: 'hr',
				managerComments: note,
				score: weightedScore(rated),
				managerSubmittedAt: new Date(),
				managerUserId: m.user.userId
			})
			.where(eq(reviews.id, id));
	});
}

const readyNotice = (tx: Tx, m: Member, r: { review: { id: string; employeeId: string }; cycleName: string }) =>
	activeMemberships(tx, r.review.employeeId).then((ids) =>
		notify(
			tx,
			m.tenant.id,
			ids,
			{
				category: 'performance',
				title: `Your ${r.cycleName} review is ready`,
				link: `performance/reviews/${r.review.id}`
			},
			m.tenant.slug
		)
	);

export async function finaliseReview(m: Member, raw: Record<string, string>) {
	const id = reviewId.parse(raw.reviewId);
	const share = raw.share === 'on';
	return withTenant(userCtx(m), async (tx) => {
		const r = await editable(tx, m.access, id, 'finalise');
		await tx
			.update(reviews)
			.set({ stage: 'done', shared: share, finalisedAt: new Date(), finalisedByUserId: m.user.userId })
			.where(eq(reviews.id, id));
		return share ? readyNotice(tx, m, r) : [];
	});
}

export async function shareReview(m: Member, raw: Record<string, string>) {
	const id = reviewId.parse(raw.reviewId);
	return withTenant(userCtx(m), async (tx) => {
		const r = await editable(tx, m.access, id, 'share');
		await tx.update(reviews).set({ shared: true }).where(eq(reviews.id, id));
		return readyNotice(tx, m, r);
	});
}
