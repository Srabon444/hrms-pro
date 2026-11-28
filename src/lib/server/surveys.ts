import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audienceFilter } from './announcements';
import { activeMember, audienceMembers, memberNames } from './audience';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import {
	branches,
	departments,
	employees,
	EVENT_AUDIENCES,
	QUESTION_KINDS,
	surveyAnswers,
	surveyParticipation,
	surveyQuestions,
	surveys
} from './db/schema';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { advisoryLock, LOCK } from './locks';
import type { Mail } from './mail';
import { notify, sendAll } from './notifications';
import { hitOrLocal } from './ratelimit';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Survey = typeof surveys.$inferSelect;
type Question = typeof surveyQuestions.$inferSelect;

export const SURVEY_MAX_QUESTIONS = 20;
export const SUGGESTIONS_PER_DAY = 5;
export const SURVEY_TEXT_MAX = 2000;
const TEXTS_SHOWN = 500;
const RANGE = { scale: [1, 5], enps: [0, 10] } as const;

export function enps(counts: number[]) {
	const at = (from: number, to: number) => counts.slice(from, to + 1).reduce((a, b) => a + b, 0);
	const total = at(0, 10);
	const promoters = at(9, 10);
	const detractors = at(0, 6);
	const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
	return {
		total,
		promoters: pct(promoters),
		passives: pct(total - promoters - detractors),
		detractors: pct(detractors),
		score: total ? Math.round(((promoters - detractors) / total) * 100) : 0
	};
}

export function hiddenSlices(counts: Map<string, number>, min: number): Set<string> {
	const hidden = new Set([...counts].filter(([, n]) => n < min).map(([k]) => k));
	const visible = [...counts].filter(([k]) => !hidden.has(k)).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
	let hiddenTotal = [...hidden].reduce((sum, k) => sum + counts.get(k)!, 0);
	while (hidden.size && hiddenTotal < min && visible.length) {
		const [k, n] = visible.shift()!;
		hidden.add(k);
		hiddenTotal += n;
	}
	return hidden;
}

const NUL = 'Remove unsupported characters.';
const noNul = (v: string) => !v.includes('\0');

export const canRunSurveys = (access: Access) => scopesOf(access, 'survey.manage').includes('all');
const onlyManagers = (access: Access) => {
	if (!canRunSurveys(access)) throw new AppError('forbidden', 'Only people who manage surveys can do that.', 403);
};
const notFound = () => new AppError('not_found', 'That survey does not exist.', 404);
const surveyId = z.uuid({ error: 'Choose a survey.' });

const optionalId = z
	.union([z.literal(''), z.uuid()])
	.transform((v) => v || null)
	.prefault('');

const questionSchema = z
	.object({
		kind: z.enum(QUESTION_KINDS, 'Choose a question type.'),
		prompt: z
			.string()
			.trim()
			.min(1, 'Write every question.')
			.max(300, 'Keep each question under 300 characters.')
			.refine(noNul, NUL),
		options: z
			.array(
				z
					.string()
					.trim()
					.min(1, 'Remove empty choices.')
					.max(100, 'Keep each choice under 100 characters.')
					.refine(noNul, NUL)
			)
			.max(10, 'A question can have at most 10 choices.')
			.default([]),
		required: z.boolean().default(true)
	})
	.transform((q) => ({ ...q, options: q.kind === 'choice' ? q.options : [] }))
	.refine((q) => q.kind !== 'choice' || q.options.length >= 2, {
		message: 'Give each choice question two or more choices.'
	})
	.refine((q) => new Set(q.options.map((o) => o.toLowerCase())).size === q.options.length, {
		message: 'Choices in one question must differ.'
	});

const surveySchema = z
	.object({
		title: z.string().trim().min(1, 'Add a title.').max(160, 'Keep the title under 160 characters.').refine(noNul, NUL),
		intro: z.string().trim().max(2000, 'Keep the introduction under 2000 characters.').refine(noNul, NUL).prefault(''),
		anonymous: z.preprocess((v) => v === true || ['on', 'true', '1', 'yes'].includes(String(v)), z.boolean()),
		audience: z.enum(EVENT_AUDIENCES, 'Choose who is asked.'),
		departmentId: optionalId,
		branchId: optionalId,
		closesOn: z.iso.date('Enter the closing date.'),
		minGroupSize: z.coerce
			.number('Enter the smallest group size.')
			.int('Enter a whole number.')
			.min(5, 'The smallest group must be at least 5.')
			.max(50, 'The smallest group can be at most 50.'),
		questions: z.preprocess(
			(v) => {
				try {
					return typeof v === 'string' ? JSON.parse(v) : v;
				} catch {
					return null;
				}
			},
			z
				.array(questionSchema, 'Add at least one question.')
				.min(1, 'Add at least one question.')
				.max(SURVEY_MAX_QUESTIONS, `A survey can have at most ${SURVEY_MAX_QUESTIONS} questions.`)
		)
	})
	.refine((v) => v.audience !== 'department' || v.departmentId, { message: 'Choose the department.' })
	.refine((v) => v.audience !== 'branch' || v.branchId, { message: 'Choose the branch.' })
	.transform((v) => ({
		...v,
		departmentId: v.audience === 'department' ? v.departmentId : null,
		branchId: v.audience === 'branch' ? v.branchId : null
	}));

const isOpen = (s: Pick<Survey, 'status' | 'closesOn' | 'kind'>, today: string) =>
	s.status === 'open' && (s.kind === 'suggestion' || (s.closesOn !== null && s.closesOn >= today));
const isClosed = (s: Pick<Survey, 'status' | 'closesOn'>, today: string) =>
	s.status === 'closed' || (s.status === 'open' && s.closesOn !== null && s.closesOn < today);

async function managed(tx: Tx, id: string, lock = false) {
	const q = tx
		.select()
		.from(surveys)
		.where(and(eq(surveys.id, surveyId.parse(id)), eq(surveys.kind, 'pulse')));
	const [s] = await (lock ? q.for('update') : q);
	if (!s) throw notFound();
	return s;
}

export async function createSurvey(m: Member, raw: Record<string, string>) {
	onlyManagers(m.access);
	const { questions, ...input } = surveySchema.parse(raw);
	return withTenant(userCtx(m), async (tx) => {
		if (input.closesOn < (await tenantToday(tx)))
			throw new AppError('past_close', 'The closing date cannot be in the past.', 400);
		if (input.departmentId) {
			const [d] = await tx
				.select({ id: departments.id })
				.from(departments)
				.where(eq(departments.id, input.departmentId));
			if (!d) throw new AppError('invalid_department', 'Choose an existing department.', 400);
		}
		if (input.branchId) {
			const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
			if (!b) throw new AppError('invalid_branch', 'Choose an existing branch.', 400);
		}
		const [s] = await tx
			.insert(surveys)
			.values({ tenantId: m.tenant.id, ...input, createdByUserId: m.user.userId })
			.returning({ id: surveys.id });
		await tx
			.insert(surveyQuestions)
			.values(questions.map((q, position) => ({ tenantId: m.tenant.id, surveyId: s.id, position, ...q })));
		return s.id;
	});
}

export async function openSurvey(m: Member, id: string) {
	onlyManagers(m.access);
	const mails = await withTenant(userCtx(m), async (tx) => {
		const s = await managed(tx, id, true);
		if (s.status !== 'draft') throw new AppError('not_draft', 'Only a draft survey can be opened.', 409);
		if (s.closesOn! < (await tenantToday(tx)))
			throw new AppError('past_close', 'The closing date has passed. Create the survey again with a later date.', 409);
		const people = await audienceMembers(tx, s);
		if (!people.length) throw new AppError('audience_empty', 'Nobody is in this audience yet.', 409);
		if (s.anonymous && people.length < s.minGroupSize)
			throw new AppError(
				'audience_too_small',
				`An anonymous survey needs at least ${s.minGroupSize} people in its audience; this one has ${people.length}.`,
				409
			);
		await tx.update(surveys).set({ status: 'open', openedAt: new Date() }).where(eq(surveys.id, s.id));
		return notify(
			tx,
			m.tenant.id,
			people,
			{
				category: 'surveys',
				title: `Survey: ${s.title}`,
				body: `Please answer by ${s.closesOn}.`,
				link: `surveys/${s.id}`
			},
			m.tenant.slug
		);
	});
	await sendAll(mails);
}

export async function closeSurvey(m: Member, id: string) {
	onlyManagers(m.access);
	await withTenant(userCtx(m), async (tx) => {
		const s = await managed(tx, id, true);
		if (s.status !== 'open') throw new AppError('not_open', 'Only an open survey can be closed.', 409);
		await tx.update(surveys).set({ status: 'closed', closedAt: new Date() }).where(eq(surveys.id, s.id));
	});
}

export async function deleteSurvey(m: Member, id: string) {
	onlyManagers(m.access);
	await withTenant(userCtx(m), async (tx) => {
		const s = await managed(tx, id, true);
		await tx.delete(surveys).where(eq(surveys.id, s.id));
	});
}

async function participantIds(tx: Tx, id: string) {
	const rows = await tx
		.select({ id: surveyParticipation.membershipId })
		.from(surveyParticipation)
		.where(eq(surveyParticipation.surveyId, id));
	return new Set(rows.map((r) => r.id));
}

export async function remindSurvey(m: Member, id: string) {
	onlyManagers(m.access);
	let mails: Mail[] = [];
	const count = await withTenant(userCtx(m), async (tx) => {
		const s = await managed(tx, id, true);
		if (!isOpen(s, await tenantToday(tx)))
			throw new AppError('not_open', 'Only an open survey can send reminders.', 409);
		if (s.remindersSent >= 2) throw new AppError('reminders_used', 'This survey already sent its two reminders.', 409);
		const done = await participantIds(tx, s.id);
		const waiting = (await audienceMembers(tx, s)).filter((p) => !done.has(p));
		if (!waiting.length) return 0;
		await tx
			.update(surveys)
			.set({ remindersSent: s.remindersSent + 1 })
			.where(eq(surveys.id, s.id));
		mails = await notify(
			tx,
			m.tenant.id,
			waiting,
			{
				category: 'surveys',
				title: `Reminder: ${s.title}`,
				body: `The survey closes on ${s.closesOn}.`,
				link: `surveys/${s.id}`
			},
			m.tenant.slug
		);
		return waiting.length;
	});
	await sendAll(mails);
	return count;
}

const listFields = {
	id: surveys.id,
	title: surveys.title,
	anonymous: surveys.anonymous,
	status: surveys.status,
	closesOn: surveys.closesOn,
	audience: surveys.audience,
	target: sql<string | null>`coalesce(${departments.name}, ${branches.name})`
};

export async function surveysPage(tx: Tx, access: Access) {
	const today = await tenantToday(tx);
	const manager = canRunSurveys(access);
	const mine = await tx
		.select({
			...listFields,
			answered: sql<boolean>`exists (select 1 from survey_participation p where p.survey_id = ${surveys.id} and p.membership_id = ${access.membershipId}::uuid)`
		})
		.from(surveys)
		.leftJoin(departments, eq(departments.id, surveys.departmentId))
		.leftJoin(branches, eq(branches.id, surveys.branchId))
		.where(
			and(
				eq(surveys.kind, 'pulse'),
				eq(surveys.status, 'open'),
				sql`${surveys.closesOn} >= ${today}`,
				activeMember(access.membershipId),
				await audienceFilter(tx, access.employeeId, surveys)
			)
		)
		.orderBy(asc(surveys.closesOn), asc(surveys.title))
		.limit(100);
	const all = manager
		? await tx
				.select({
					...listFields,
					responses: sql<number>`(select count(*)::int from survey_participation p where p.survey_id = ${surveys.id})`
				})
				.from(surveys)
				.leftJoin(departments, eq(departments.id, surveys.departmentId))
				.leftJoin(branches, eq(branches.id, surveys.branchId))
				.where(eq(surveys.kind, 'pulse'))
				.orderBy(desc(surveys.createdAt))
				.limit(200)
		: [];
	const [d, b] = manager
		? await Promise.all([
				tx.select({ id: departments.id, name: departments.name }).from(departments).orderBy(departments.name),
				tx.select({ id: branches.id, name: branches.name }).from(branches).orderBy(branches.name)
			])
		: [[], []];
	return {
		today,
		manager,
		mine,
		all: all.map((s) => ({ ...s, state: isClosed(s, today) ? 'closed' : s.status })),
		departments: d,
		branches: b
	};
}

const questionFields = {
	id: surveyQuestions.id,
	kind: surveyQuestions.kind,
	prompt: surveyQuestions.prompt,
	options: surveyQuestions.options,
	required: surveyQuestions.required
};

const questionsOf = (tx: Tx, id: string) =>
	tx
		.select(questionFields)
		.from(surveyQuestions)
		.where(eq(surveyQuestions.surveyId, id))
		.orderBy(asc(surveyQuestions.position));

export async function surveyPage(tx: Tx, access: Access, id: string) {
	const sid = surveyId.safeParse(id);
	if (!sid.success) throw notFound();
	const today = await tenantToday(tx);
	const manager = canRunSurveys(access);
	const [s] = await tx
		.select()
		.from(surveys)
		.where(
			and(
				eq(surveys.id, sid.data),
				eq(surveys.kind, 'pulse'),
				manager ? undefined : eq(surveys.status, 'open'),
				manager ? undefined : activeMember(access.membershipId),
				manager ? undefined : await audienceFilter(tx, access.employeeId, surveys)
			)
		);
	if (!s) throw notFound();
	const [p] = await tx
		.select({ id: surveyParticipation.id })
		.from(surveyParticipation)
		.where(and(eq(surveyParticipation.surveyId, s.id), eq(surveyParticipation.membershipId, access.membershipId)));
	const audience = manager ? (await audienceMembers(tx, s)).length : 0;
	return {
		today,
		manager,
		survey: {
			id: s.id,
			title: s.title,
			intro: s.intro,
			anonymous: s.anonymous,
			status: s.status,
			state: isClosed(s, today) ? 'closed' : s.status,
			closesOn: s.closesOn,
			minGroupSize: s.minGroupSize,
			remindersSent: s.remindersSent
		},
		canAnswer: isOpen(s, today) && !p && (manager ? await audienceFilterMatch(tx, access, s.id) : true),
		answered: !!p,
		audience,
		questions: await questionsOf(tx, s.id)
	};
}

async function audienceFilterMatch(tx: Tx, access: Access, id: string) {
	const [s] = await tx
		.select({ id: surveys.id })
		.from(surveys)
		.where(and(eq(surveys.id, id), await audienceFilter(tx, access.employeeId, surveys)));
	return !!s;
}

type AnswerRow = { questionId: string; valueNum: number | null; valueText: string | null };

export function readAnswers(
	questions: Pick<Question, 'id' | 'kind' | 'options' | 'required'>[],
	raw: Record<string, string>
) {
	const out: AnswerRow[] = [];
	for (const q of questions) {
		const v = (raw[`q_${q.id}`] ?? '').trim();
		if (!v) {
			if (q.required) throw new AppError('invalid', 'Answer every required question.', 400);
			continue;
		}
		if (q.kind === 'text') {
			if (!noNul(v)) throw new AppError('invalid', NUL, 400);
			if (v.length > SURVEY_TEXT_MAX)
				throw new AppError('invalid', `Keep each written answer under ${SURVEY_TEXT_MAX} characters.`, 400);
			out.push({ questionId: q.id, valueNum: null, valueText: v });
			continue;
		}
		const n = /^\d{1,2}$/.test(v) ? Number(v) : NaN;
		const [lo, hi] = q.kind === 'choice' ? [0, q.options.length - 1] : RANGE[q.kind];
		if (!(n >= lo && n <= hi)) throw new AppError('invalid', 'Pick one of the answers offered.', 400);
		out.push({ questionId: q.id, valueNum: n, valueText: null });
	}
	return out;
}

async function sliceOf(tx: Tx, s: Survey, employeeId: string | null) {
	const [me] = employeeId
		? await tx
				.select({ departmentId: employees.departmentId, branchId: employees.branchId })
				.from(employees)
				.where(eq(employees.id, employeeId))
		: [];
	if (!me || !s.anonymous) return { departmentId: me?.departmentId ?? null, branchId: me?.branchId ?? null };
	const audience = await audienceMembers(tx, s);
	const [peers] = await tx
		.select({
			department: sql<number>`count(*) filter (where ${employees.departmentId} = ${me.departmentId}::uuid)::int`,
			branch: sql<number>`count(*) filter (where ${employees.branchId} = ${me.branchId}::uuid)::int`
		})
		.from(employees)
		.where(
			sql`${employees.id} in (select tu.employee_id from tenant_users tu where tu.membership_id in ${audience.length ? audience : [null]})`
		);
	return {
		departmentId: peers.department >= s.minGroupSize ? me.departmentId : null,
		branchId: peers.branch >= s.minGroupSize ? me.branchId : null
	};
}

const lockOpen = async (tx: Tx, id: string, employeeId: string | null, membershipId: string) => {
	const [s] = await tx
		.select()
		.from(surveys)
		.where(
			and(
				eq(surveys.id, id),
				eq(surveys.kind, 'pulse'),
				activeMember(membershipId),
				await audienceFilter(tx, employeeId, surveys)
			)
		)
		.for('share');
	if (!s || !isOpen(s, await tenantToday(tx))) throw new AppError('not_open', 'This survey is not open.', 409);
	return s;
};

export async function submitSurvey(m: Member, id: string, raw: Record<string, string>) {
	const sid = surveyId.parse(id);
	const ctx = userCtx(m);
	const prepared = await withTenant(ctx, async (tx) => {
		const s = await lockOpen(tx, sid, m.access.employeeId, m.access.membershipId);
		const rows = readAnswers(await questionsOf(tx, s.id), raw);
		if (!rows.length) throw new AppError('invalid', 'Answer at least one question.', 400);
		const slice = await sliceOf(tx, s, m.access.employeeId);
		try {
			await tx
				.insert(surveyParticipation)
				.values({ tenantId: m.tenant.id, surveyId: s.id, membershipId: m.access.membershipId });
		} catch (err) {
			if (pgCode(err) === UNIQUE_VIOLATION) throw new AppError('answered', 'You already answered this survey.', 409);
			throw err;
		}
		return rows.map((r) => ({
			...r,
			tenantId: m.tenant.id,
			surveyId: s.id,
			anonymous: s.anonymous,
			sliceDepartmentId: s.anonymous && r.valueText !== null ? null : slice.departmentId,
			sliceBranchId: s.anonymous && r.valueText !== null ? null : slice.branchId,
			membershipId: s.anonymous ? null : m.access.membershipId
		}));
	});
	try {
		await withTenant(ctx, async (tx) => {
			const s = await lockOpen(tx, sid, m.access.employeeId, m.access.membershipId);
			await tx.insert(surveyAnswers).values(prepared);
			if (!s.anonymous) return;
			await advisoryLock(tx, LOCK.survey, s.id);
			await tx.execute(sql`
				with gone as (
					delete from survey_participation where survey_id = ${s.id}::uuid
					returning id, tenant_id, survey_id, membership_id
				)
				insert into survey_participation (id, tenant_id, survey_id, membership_id)
				select id, tenant_id, survey_id, membership_id from gone order by random()`);
		});
	} catch (err) {
		await withTenant(ctx, (tx) =>
			tx
				.delete(surveyParticipation)
				.where(and(eq(surveyParticipation.surveyId, sid), eq(surveyParticipation.membershipId, m.access.membershipId)))
		);
		if (err instanceof AppError) throw err;
		throw new Error(`survey answers could not be saved (${pgCode(err) ?? 'unknown'})`);
	}
}

export async function responseCount(tx: Tx, id: string) {
	const [{ n }] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(surveyParticipation)
		.where(eq(surveyParticipation.surveyId, id));
	const [{ answered }] = await tx.select({ answered: sql<number>`coalesce(max(per_question), 0)::int` }).from(
		tx
			.select({ perQuestion: sql<number>`count(*)`.as('per_question') })
			.from(surveyAnswers)
			.where(eq(surveyAnswers.surveyId, id))
			.groupBy(surveyAnswers.questionId)
			.as('q')
	);
	return Math.max(n, answered);
}

export const SLICE_DIMENSIONS = ['department', 'branch'] as const;
export type SliceDimension = (typeof SLICE_DIMENSIONS)[number];

type Tally = { total: number; avg: number | null; dist: number[]; enps: ReturnType<typeof enps> | null };

const tally = (kind: Question['kind'], size: number, counts: Map<number, number>): Tally => {
	const dist = Array.from({ length: size }, (_, i) => counts.get(kind === 'scale' ? i + 1 : i) ?? 0);
	const total = dist.reduce((a, b) => a + b, 0);
	const sum = [...counts].reduce((a, [v, n]) => a + v * n, 0);
	return {
		total,
		dist,
		avg: kind === 'scale' && total ? Math.round((sum / total) * 10) / 10 : null,
		enps: kind === 'enps' ? enps(dist) : null
	};
};

const sizeOf = (q: Pick<Question, 'kind' | 'options'>) =>
	q.kind === 'scale' ? 5 : q.kind === 'enps' ? 11 : q.options.length;

async function numberCounts(tx: Tx, id: string, dimension: SliceDimension | null) {
	const slice =
		dimension === 'department'
			? surveyAnswers.sliceDepartmentId
			: dimension === 'branch'
				? surveyAnswers.sliceBranchId
				: sql<string | null>`null::uuid`;
	return tx
		.select({
			questionId: surveyAnswers.questionId,
			slice: sql<string | null>`${slice}`,
			value: surveyAnswers.valueNum,
			n: sql<number>`count(*)::int`
		})
		.from(surveyAnswers)
		.where(and(eq(surveyAnswers.surveyId, id), sql`${surveyAnswers.valueNum} is not null`))
		.groupBy(surveyAnswers.questionId, sql`2`, surveyAnswers.valueNum);
}

const anonymousTexts = (tx: Tx, id: string) =>
	tx
		.select({
			questionId: surveyAnswers.questionId,
			text: surveyAnswers.valueText,
			membershipId: sql<string | null>`null::uuid`
		})
		.from(surveyAnswers)
		.where(
			and(
				eq(surveyAnswers.surveyId, id),
				eq(surveyAnswers.anonymous, true),
				sql`${surveyAnswers.valueText} is not null`
			)
		)
		.orderBy(sql`random()`)
		.limit(TEXTS_SHOWN);

const namedTexts = (tx: Tx, id: string) =>
	tx
		.select({
			questionId: surveyAnswers.questionId,
			text: surveyAnswers.valueText,
			membershipId: surveyAnswers.membershipId
		})
		.from(surveyAnswers)
		.where(
			and(
				eq(surveyAnswers.surveyId, id),
				eq(surveyAnswers.anonymous, false),
				sql`${surveyAnswers.valueText} is not null`
			)
		)
		.orderBy(asc(surveyAnswers.questionId))
		.limit(TEXTS_SHOWN);

async function sliceLabels(tx: Tx, dimension: SliceDimension, ids: string[]) {
	const t = dimension === 'department' ? departments : branches;
	const rows = ids.length ? await tx.select({ id: t.id, name: t.name }).from(t).where(inArray(t.id, ids)) : [];
	return new Map(rows.map((r) => [r.id, r.name]));
}

export async function surveyResults(tx: Tx, access: Access, id: string, rawDimension: string | null) {
	onlyManagers(access);
	const s = await managed(tx, id);
	const today = await tenantToday(tx);
	const dimension = SLICE_DIMENSIONS.find((d) => d === rawDimension) ?? null;
	const responses = await responseCount(tx, s.id);
	const suppress = s.anonymous;
	if (suppress && !isClosed(s, today)) return { ready: false as const, reason: 'open' as const, responses, dimension };
	if (suppress && responses < s.minGroupSize)
		return { ready: false as const, reason: 'too_few' as const, responses, dimension };
	const questions = await questionsOf(tx, s.id);
	const counts = await numberCounts(tx, s.id, dimension);
	const texts = s.anonymous ? await anonymousTexts(tx, s.id) : await namedTexts(tx, s.id);
	const names = await memberNames(tx, [...new Set(texts.map((t) => t.membershipId).filter((v): v is string => !!v))]);
	const sliceIds = [...new Set(counts.map((c) => c.slice).filter((v): v is string => !!v))];
	const labels = dimension ? await sliceLabels(tx, dimension, sliceIds) : new Map<string, string>();
	return {
		ready: true as const,
		responses,
		dimension,
		questions: questions.map((q) => {
			const mine = counts.filter((c) => c.questionId === q.id);
			const overall = new Map<number, number>();
			for (const c of mine) overall.set(c.value!, (overall.get(c.value!) ?? 0) + c.n);
			const whole = tally(q.kind, sizeOf(q), overall);
			const hidden = suppress && q.kind !== 'text' && whole.total < s.minGroupSize;
			const bySlice = new Map<string, Map<number, number>>();
			for (const c of mine) {
				const key = c.slice ?? '';
				const m = bySlice.get(key) ?? new Map<number, number>();
				m.set(c.value!, (m.get(c.value!) ?? 0) + c.n);
				bySlice.set(key, m);
			}
			const sliceTallies = [...bySlice].map(([key, m]) => ({ key, ...tally(q.kind, sizeOf(q), m) }));
			const off = suppress
				? hiddenSlices(new Map(sliceTallies.map((t) => [t.key, t.total])), s.minGroupSize)
				: new Set<string>();
			return {
				...q,
				hidden,
				...(hidden ? { total: whole.total, avg: null, dist: [], enps: null } : whole),
				texts:
					q.kind === 'text'
						? texts
								.filter((t) => t.questionId === q.id)
								.map((t) => ({
									text: t.text!,
									name: t.membershipId ? (names.get(t.membershipId) ?? null) : null
								}))
						: [],
				slices:
					dimension && q.kind !== 'text' && !hidden
						? sliceTallies
								.map((t) =>
									off.has(t.key)
										? { key: t.key, label: labels.get(t.key) ?? 'Other or not set', hidden: true as const }
										: { ...t, label: labels.get(t.key) ?? 'Other or not set', hidden: false as const }
								)
								.sort((a, b) => a.label.localeCompare(b.label))
						: []
			};
		})
	};
}

async function suggestionBox(tx: Tx, tenantId: string) {
	await tx
		.insert(surveys)
		.values({ tenantId, kind: 'suggestion', title: 'Suggestion box', status: 'open', anonymous: true })
		.onConflictDoNothing();
	const [s] = await tx.select().from(surveys).where(eq(surveys.kind, 'suggestion'));
	await tx
		.insert(surveyQuestions)
		.values({ tenantId, surveyId: s.id, position: 0, kind: 'text', prompt: 'Your suggestion', required: true })
		.onConflictDoNothing();
	const [q] = await tx
		.select({ id: surveyQuestions.id })
		.from(surveyQuestions)
		.where(eq(surveyQuestions.surveyId, s.id));
	return { survey: s, questionId: q.id };
}

const suggestionSchema = z
	.string()
	.trim()
	.min(1, 'Write your suggestion.')
	.max(SURVEY_TEXT_MAX, `Keep it under ${SURVEY_TEXT_MAX} characters.`)
	.refine(noNul, NUL);

export async function submitSuggestion(m: Member, raw: string) {
	const text = suggestionSchema.parse(raw);
	const now = new Date();
	const untilMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
	const day = now.toISOString().slice(0, 10);
	const limited = await hitOrLocal('suggestion', `${m.access.membershipId}:${day}`, SUGGESTIONS_PER_DAY, untilMidnight);
	if (!limited.ok)
		throw new AppError('too_many', `You can send ${SUGGESTIONS_PER_DAY} suggestions a day. Try again tomorrow.`, 429);
	const box = await withTenant(systemCtx(m.tenant.id), (tx) => suggestionBox(tx, m.tenant.id));
	await withTenant(userCtx(m), async (tx) => {
		await tx.insert(surveyAnswers).values({
			tenantId: m.tenant.id,
			surveyId: box.survey.id,
			anonymous: true,
			questionId: box.questionId,
			valueText: text
		});
	});
}

export async function suggestionsPage(tx: Tx, access: Access, tenantId: string) {
	onlyManagers(access);
	const box = await suggestionBox(tx, tenantId);
	const [s] = await tx.select().from(surveys).where(eq(surveys.id, box.survey.id)).for('update');
	const [{ waiting }] = await tx
		.select({ waiting: sql<number>`count(*)::int` })
		.from(surveyAnswers)
		.where(and(eq(surveyAnswers.surveyId, s.id), isNull(surveyAnswers.batch)));
	let batches = s.releasedBatches;
	if (waiting >= s.minGroupSize) {
		batches += 1;
		await tx
			.update(surveyAnswers)
			.set({ batch: batches })
			.where(and(eq(surveyAnswers.surveyId, s.id), isNull(surveyAnswers.batch)));
		await tx.update(surveys).set({ releasedBatches: batches }).where(eq(surveys.id, s.id));
	}
	const released = await tx
		.select({ batch: surveyAnswers.batch, text: surveyAnswers.valueText })
		.from(surveyAnswers)
		.where(and(eq(surveyAnswers.surveyId, s.id), sql`${surveyAnswers.batch} is not null`))
		.orderBy(desc(surveyAnswers.batch), sql`random()`)
		.limit(TEXTS_SHOWN);
	return { minGroupSize: s.minGroupSize, batches, entries: released.map((r) => ({ batch: r.batch!, text: r.text! })) };
}

export async function forgetLeavers(tx: Tx, membershipIds: string[]) {
	if (!membershipIds.length) return;
	await tx.delete(surveyParticipation).where(inArray(surveyParticipation.membershipId, membershipIds));
	await tx
		.delete(surveyAnswers)
		.where(and(eq(surveyAnswers.anonymous, false), inArray(surveyAnswers.membershipId, membershipIds)));
}
