import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { activeMemberships } from './approval-chain';
import { memberNames, requireActiveMember } from './audience';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { employees, feedback, feedbackRequests, memberships } from './db/schema';
import { AppError } from './errors';
import type { Mail } from './mail';
import { notify, sendAll } from './notifications';
import { hitOrLocal } from './ratelimit';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const FEEDBACK_PER_DAY = 30;
export const FEEDBACK_REQUESTS_PER_DAY = 20;
const LIST_SIZE = 100;
const FORMER = 'Former employee';
const ACTIVE = ['probation', 'active', 'notice'];
const NUL = 'Remove unsupported characters.';
const noNul = (v: string) => !v.includes('\0');

const giveSchema = z.object({
	toEmployeeId: z.uuid('Choose who the feedback is for.'),
	text: z
		.string('Write the feedback.')
		.trim()
		.min(1, 'Write the feedback.')
		.max(2000, 'Keep the feedback under 2000 characters.')
		.refine(noNul, NUL),
	visibility: z.enum(['manager_only', 'shared'], 'Choose who can read it.'),
	requestId: z
		.union([z.literal(''), z.uuid('Choose a request.')])
		.transform((v) => v || null)
		.prefault('')
});

const requestSchema = z.object({
	askedMembershipId: z.uuid('Choose who to ask.'),
	note: z.string().trim().max(500, 'Keep the note under 500 characters.').refine(noNul, NUL).prefault('')
});

const limit = async (m: Member, bucket: string, max: number) => {
	const r = await hitOrLocal(bucket, m.access.membershipId, max, 86_400_000);
	if (!r.ok) throw new AppError('too_many', 'You have reached today’s limit. Try again tomorrow.', 429);
};

const colleagues = (tx: Tx, where = sql`true`) =>
	tx.execute<{ membershipId: string; employeeId: string; name: string }>(sql`
		select tu.membership_id as "membershipId", tu.employee_id as "employeeId", tu.name
		from tenant_users tu join employees e on e.id = tu.employee_id
		where tu.membership_status = 'active' and tu.user_status = 'active'
			and e.status in ('probation', 'active', 'notice') and ${where}`);

const employeeNames = async (tx: Tx, ids: string[]) =>
	new Map(
		(ids.length
			? await tx
					.select({ id: employees.id, name: employees.fullName })
					.from(employees)
					.where(inArray(employees.id, ids))
			: []
		).map((e) => [e.id, e.name])
	);

export async function giveFeedback(m: Member, raw: Record<string, string>) {
	const input = giveSchema.parse(raw);
	const me = m.access.membershipId;
	if (input.toEmployeeId === m.access.employeeId)
		throw new AppError('self', 'You cannot give feedback to yourself.', 400);
	let mails: Mail[] = [];
	await withTenant(userCtx(m), async (tx) => {
		await requireActiveMember(tx, me);
		const [to] = await tx
			.select({ id: employees.id, status: employees.status })
			.from(employees)
			.where(eq(employees.id, input.toEmployeeId));
		if (!to || !ACTIVE.includes(to.status)) throw new AppError('invalid_person', 'Choose someone from the list.', 400);
		const names = await memberNames(tx, [me]);
		let requester: string | null = null;
		if (input.requestId) {
			const [r] = await tx
				.update(feedbackRequests)
				.set({ status: 'answered' })
				.where(
					and(
						eq(feedbackRequests.id, input.requestId),
						eq(feedbackRequests.askedMembershipId, me),
						eq(feedbackRequests.aboutEmployeeId, to.id),
						eq(feedbackRequests.status, 'open')
					)
				)
				.returning({ requester: feedbackRequests.requesterMembershipId });
			if (!r) throw new AppError('not_found', 'That request is no longer open.', 404);
			requester = r.requester;
		}
		await limit(m, 'feedback', FEEDBACK_PER_DAY);
		await tx.insert(feedback).values({
			tenantId: m.tenant.id,
			fromMembershipId: me,
			toEmployeeId: to.id,
			text: input.text,
			visibility: input.visibility
		});
		const from = names.get(me) ?? 'Someone';
		const recipients = requester
			? [requester]
			: input.visibility === 'shared'
				? await activeMemberships(tx, to.id)
				: [];
		mails = await notify(
			tx,
			m.tenant.id,
			recipients,
			{
				category: 'feedback',
				title: requester ? `${from} answered your feedback request` : `${from} gave you feedback`,
				body:
					input.visibility === 'shared'
						? 'Open Feedback to read it.'
						: 'They chose to share it with your manager and HR only.',
				link: 'feedback'
			},
			m.tenant.slug
		);
	});
	await sendAll(mails);
}

export async function requestFeedback(m: Member, raw: Record<string, string>) {
	const input = requestSchema.parse(raw);
	const me = m.access.membershipId;
	const employeeId = m.access.employeeId;
	if (!employeeId) throw new AppError('forbidden', 'Only employees can ask for feedback.', 403);
	if (input.askedMembershipId === me) throw new AppError('self', 'Ask someone other than yourself.', 400);
	let mails: Mail[] = [];
	await withTenant(userCtx(m), async (tx) => {
		await requireActiveMember(tx, me);
		const [asked] = await colleagues(tx, sql`tu.membership_id = ${input.askedMembershipId}::uuid`);
		if (!asked) throw new AppError('invalid_person', 'Choose someone from the list.', 400);
		await limit(m, 'feedback_request', FEEDBACK_REQUESTS_PER_DAY);
		await tx
			.insert(feedbackRequests)
			.values({
				tenantId: m.tenant.id,
				requesterMembershipId: me,
				aboutEmployeeId: employeeId,
				askedMembershipId: asked.membershipId,
				note: input.note
			})
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('already_asked', 'You already asked them. Wait for their answer.', 409);
				throw err;
			});
		const names = await memberNames(tx, [me]);
		mails = await notify(
			tx,
			m.tenant.id,
			[asked.membershipId],
			{
				category: 'feedback',
				title: `${names.get(me) ?? 'Someone'} asked you for feedback`,
				body: input.note || undefined,
				link: 'feedback'
			},
			m.tenant.slug
		);
	});
	await sendAll(mails);
}

export async function declineRequest(m: Member, rawId: string) {
	const id = z.uuid({ error: 'Choose a request.' }).parse(rawId);
	await withTenant(userCtx(m), async (tx) => {
		await requireActiveMember(tx, m.access.membershipId);
		const [r] = await tx
			.update(feedbackRequests)
			.set({ status: 'declined' })
			.where(
				and(
					eq(feedbackRequests.id, id),
					eq(feedbackRequests.askedMembershipId, m.access.membershipId),
					eq(feedbackRequests.status, 'open')
				)
			)
			.returning({ id: feedbackRequests.id });
		if (!r) throw new AppError('not_found', 'That request is no longer open.', 404);
	});
}

export async function feedbackPage(tx: Tx, access: Access) {
	const me = access.membershipId;
	const myEmployee = access.employeeId;
	const [people, received, given, waiting, asked] = await Promise.all([
		colleagues(tx, sql`tu.membership_id <> ${me}::uuid`),
		myEmployee
			? tx
					.select({
						id: feedback.id,
						from: feedback.fromMembershipId,
						text: feedback.text,
						createdAt: feedback.createdAt
					})
					.from(feedback)
					.where(and(eq(feedback.toEmployeeId, myEmployee), eq(feedback.visibility, 'shared')))
					.orderBy(desc(feedback.createdAt))
					.limit(LIST_SIZE)
			: Promise.resolve([]),
		tx
			.select({
				id: feedback.id,
				to: feedback.toEmployeeId,
				text: feedback.text,
				visibility: feedback.visibility,
				createdAt: feedback.createdAt
			})
			.from(feedback)
			.where(eq(feedback.fromMembershipId, me))
			.orderBy(desc(feedback.createdAt))
			.limit(LIST_SIZE),
		tx
			.select({
				id: feedbackRequests.id,
				requester: feedbackRequests.requesterMembershipId,
				aboutEmployeeId: feedbackRequests.aboutEmployeeId,
				note: feedbackRequests.note
			})
			.from(feedbackRequests)
			.where(and(eq(feedbackRequests.askedMembershipId, me), eq(feedbackRequests.status, 'open')))
			.orderBy(desc(feedbackRequests.createdAt))
			.limit(LIST_SIZE),
		tx
			.select({
				id: feedbackRequests.id,
				asked: feedbackRequests.askedMembershipId,
				status: feedbackRequests.status,
				createdAt: feedbackRequests.createdAt
			})
			.from(feedbackRequests)
			.where(eq(feedbackRequests.requesterMembershipId, me))
			.orderBy(desc(feedbackRequests.createdAt))
			.limit(LIST_SIZE)
	]);
	const members = await memberNames(tx, [
		...new Set([
			...received.flatMap((f) => (f.from ? [f.from] : [])),
			...waiting.map((w) => w.requester),
			...asked.map((a) => a.asked)
		])
	]);
	const staff = await employeeNames(tx, [...new Set(given.map((g) => g.to))]);
	return {
		people: [...people].sort((a, b) => a.name.localeCompare(b.name)),
		received: received.map((f) => ({ ...f, from: f.from ? (members.get(f.from) ?? FORMER) : FORMER })),
		given: given.map((g) => ({ ...g, to: staff.get(g.to) ?? '' })),
		waiting: waiting.map((w) => ({ ...w, requester: members.get(w.requester) ?? FORMER })),
		asked: asked.map((a) => ({ ...a, asked: members.get(a.asked) ?? FORMER }))
	};
}

export async function feedbackFor(tx: Tx, access: Access, employeeId: string, from: string, to: string) {
	const own = access.employeeId === employeeId;
	const lead =
		!own &&
		(inScope(await resolveScope(tx, access, 'performance.review'), employeeId) ||
			inScope(await resolveScope(tx, access, 'performance.manage'), employeeId));
	if (!own && !lead) return [];
	const rows = await tx
		.select({
			id: feedback.id,
			from: feedback.fromMembershipId,
			text: feedback.text,
			visibility: feedback.visibility,
			createdAt: feedback.createdAt
		})
		.from(feedback)
		.where(
			and(
				eq(feedback.toEmployeeId, employeeId),
				own ? eq(feedback.visibility, 'shared') : undefined,
				sql`(${feedback.createdAt} at time zone coalesce((select s.timezone from tenant_settings s), 'UTC'))::date between ${from}::date and ${to}::date`
			)
		)
		.orderBy(desc(feedback.createdAt))
		.limit(LIST_SIZE);
	const names = await memberNames(tx, [...new Set(rows.flatMap((r) => (r.from ? [r.from] : [])))]);
	return rows.map((r) => ({ ...r, from: r.from ? (names.get(r.from) ?? FORMER) : FORMER }));
}

export async function forgetFeedback(tx: Tx, membershipIds: string[]) {
	if (!membershipIds.length) return;
	await tx.update(feedback).set({ fromMembershipId: null }).where(inArray(feedback.fromMembershipId, membershipIds));
	await tx.delete(feedback).where(
		inArray(
			feedback.toEmployeeId,
			tx
				.select({ id: memberships.employeeId })
				.from(memberships)
				.where(and(inArray(memberships.id, membershipIds), isNotNull(memberships.employeeId)))
		)
	);
	await tx
		.delete(feedbackRequests)
		.where(
			or(
				inArray(feedbackRequests.requesterMembershipId, membershipIds),
				inArray(feedbackRequests.askedMembershipId, membershipIds)
			)
		);
}
