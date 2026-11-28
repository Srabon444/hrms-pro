import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canRunAnnouncements, liveFor } from './announcements';
import { audienceMembers, memberNames } from './audience';
import { announcementComments, announcementReactions, announcements, REACTION_KINDS } from './db/schema';
import { AppError } from './errors';
import type { Mail } from './mail';
import { notify, sendAll } from './notifications';
import { hitOrLocal } from './ratelimit';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const COMMENTS_PER_MINUTE = 10;
export const MAX_MENTIONS = 10;
export const REACTIONS_PER_MINUTE = 30;
const THREAD_SIZE = 500;
const FORMER = 'Former employee';

const notFound = () => new AppError('not_found', 'That announcement does not exist.', 404);
const announcementId = z.uuid({ error: 'Choose an announcement.' });

const commentSchema = z.object({
	body: z
		.string('Write a comment.')
		.trim()
		.min(1, 'Write a comment.')
		.max(2000, 'Keep the comment under 2000 characters.')
		.refine((v) => !v.includes('\0'), 'Remove unsupported characters.'),
	mentions: z
		.array(z.uuid('Choose people from the list.'))
		.max(MAX_MENTIONS, `Mention at most ${MAX_MENTIONS} people.`)
		.transform((ids) => [...new Set(ids)])
		.prefault([])
});

async function readable(tx: Tx, access: Access, id: string) {
	const aid = announcementId.safeParse(id);
	if (!aid.success) throw notFound();
	const manager = canRunAnnouncements(access);
	const live = await liveFor(tx, access);
	const [a] = await tx
		.select({
			id: announcements.id,
			title: announcements.title,
			body: announcements.body,
			publishOn: announcements.publishOn,
			audience: announcements.audience,
			departmentId: announcements.departmentId,
			branchId: announcements.branchId,
			live: sql<boolean>`coalesce(${live}, false)`
		})
		.from(announcements)
		.where(and(eq(announcements.id, aid.data), manager ? undefined : live));
	if (!a) throw notFound();
	return { ...a, manager };
}

async function writable(tx: Tx, m: Member, id: string) {
	const a = await readable(tx, m.access, id);
	const audience = new Set(a.live ? await audienceMembers(tx, a) : []);
	if (!audience.has(m.access.membershipId)) throw notFound();
	return { ...a, audience };
}

const uuids = (ids: string[]) =>
	sql`array[${sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `
	)}]::uuid[]`;

export async function threadPage(tx: Tx, access: Access, id: string) {
	const a = await readable(tx, access, id);
	const [reactions, comments, audience] = await Promise.all([
		tx
			.select({
				kind: announcementReactions.kind,
				n: sql<number>`count(*)::int`,
				mine: sql<boolean>`bool_or(${announcementReactions.membershipId} = ${access.membershipId}::uuid)`
			})
			.from(announcementReactions)
			.where(eq(announcementReactions.announcementId, a.id))
			.groupBy(announcementReactions.kind),
		tx
			.select({
				id: announcementComments.id,
				author: announcementComments.authorMembershipId,
				body: announcementComments.body,
				mentions: announcementComments.mentions,
				createdAt: announcementComments.createdAt,
				hidden: sql<boolean>`${announcementComments.hiddenAt} is not null`
			})
			.from(announcementComments)
			.where(
				and(
					eq(announcementComments.announcementId, a.id),
					a.manager ? undefined : isNull(announcementComments.hiddenAt)
				)
			)
			.orderBy(desc(announcementComments.createdAt), desc(announcementComments.id))
			.limit(THREAD_SIZE)
			.then((rows) => rows.reverse()),
		a.live ? audienceMembers(tx, a) : Promise.resolve([])
	]);
	const names = await memberNames(tx, [
		...new Set([
			...comments.flatMap((c) => (c.author ? [c.author] : [])),
			...comments.flatMap((c) => c.mentions),
			...audience
		])
	]);
	const canWrite = a.live && audience.includes(access.membershipId);
	return {
		announcement: { id: a.id, title: a.title, body: a.body, publishOn: a.publishOn },
		manager: a.manager,
		canWrite,
		reactions: REACTION_KINDS.map((kind) => {
			const r = reactions.find((x) => x.kind === kind);
			return { kind, count: r?.n ?? 0, mine: r?.mine ?? false };
		}),
		comments: comments.map((c) => ({
			id: c.id,
			body: c.body,
			createdAt: c.createdAt,
			hidden: c.hidden,
			mine: c.author === access.membershipId,
			author: c.author ? (names.get(c.author) ?? FORMER) : FORMER,
			mentions: c.mentions.map((x) => names.get(x)).filter((v): v is string => !!v)
		})),
		mentionable: canWrite
			? audience
					.filter((p) => p !== access.membershipId)
					.map((p) => ({ id: p, name: names.get(p) ?? '' }))
					.sort((x, y) => x.name.localeCompare(y.name))
			: []
	};
}

export async function toggleReaction(m: Member, id: string, rawKind: string) {
	const kind = z.enum(REACTION_KINDS, 'Choose a reaction.').parse(rawKind);
	await withTenant(userCtx(m), async (tx) => {
		const a = await writable(tx, m, id);
		const limited = await hitOrLocal('reaction', m.access.membershipId, REACTIONS_PER_MINUTE, 60_000);
		if (!limited.ok) throw new AppError('too_many', 'You are reacting too fast. Wait a minute and try again.', 429);
		const gone = await tx
			.delete(announcementReactions)
			.where(
				and(
					eq(announcementReactions.announcementId, a.id),
					eq(announcementReactions.membershipId, m.access.membershipId),
					eq(announcementReactions.kind, kind)
				)
			)
			.returning({ id: announcementReactions.id });
		if (gone.length) return;
		await tx
			.insert(announcementReactions)
			.values({ tenantId: m.tenant.id, announcementId: a.id, membershipId: m.access.membershipId, kind })
			.onConflictDoNothing();
	});
}

export async function addComment(m: Member, id: string, raw: { body?: string; mentions: string[] }) {
	const input = commentSchema.parse(raw);
	const me = m.access.membershipId;
	let mails: Mail[] = [];
	await withTenant(userCtx(m), async (tx) => {
		const a = await writable(tx, m, id);
		if (input.mentions.some((p) => p === me || !a.audience.has(p)))
			throw new AppError('invalid_mention', 'You can only mention other people who can see this announcement.', 400);
		const limited = await hitOrLocal('comment', me, COMMENTS_PER_MINUTE, 60_000);
		if (!limited.ok) throw new AppError('too_many', 'You are commenting too fast. Wait a minute and try again.', 429);
		await tx.insert(announcementComments).values({
			tenantId: m.tenant.id,
			announcementId: a.id,
			authorMembershipId: me,
			body: input.body,
			mentions: input.mentions
		});
		const names = await memberNames(tx, [me]);
		mails = await notify(
			tx,
			m.tenant.id,
			input.mentions,
			{
				category: 'mentions',
				title: `${names.get(me) ?? 'Someone'} mentioned you on "${a.title}"`,
				body: 'Open the announcement to read the comment.',
				link: `announcements/${a.id}/comments`
			},
			m.tenant.slug
		);
	});
	await sendAll(mails);
}

const commentId = z.uuid({ error: 'Choose a comment.' });
const missingComment = () => new AppError('not_found', 'That comment does not exist.', 404);

export async function deleteComment(m: Member, id: string, rawComment: string) {
	const aid = announcementId.safeParse(id);
	if (!aid.success) throw notFound();
	const cid = commentId.parse(rawComment);
	await withTenant(userCtx(m), async (tx) => {
		const [c] = await tx
			.delete(announcementComments)
			.where(
				and(
					eq(announcementComments.id, cid),
					eq(announcementComments.announcementId, aid.data),
					eq(announcementComments.authorMembershipId, m.access.membershipId)
				)
			)
			.returning({ id: announcementComments.id });
		if (!c) throw missingComment();
	});
}

export async function hideComment(m: Member, id: string, rawComment: string, hidden: boolean) {
	if (!canRunAnnouncements(m.access))
		throw new AppError('forbidden', 'Only people who manage announcements can do that.', 403);
	const cid = commentId.parse(rawComment);
	await withTenant(userCtx(m), async (tx) => {
		const a = await readable(tx, m.access, id);
		const [c] = await tx
			.update(announcementComments)
			.set(hidden ? { hiddenAt: new Date(), hiddenByUserId: m.user.userId } : { hiddenAt: null, hiddenByUserId: null })
			.where(and(eq(announcementComments.id, cid), eq(announcementComments.announcementId, a.id)))
			.returning({ id: announcementComments.id });
		if (!c) throw missingComment();
	});
}

export async function forgetCommenters(tx: Tx, membershipIds: string[]) {
	if (!membershipIds.length) return;
	await tx
		.update(announcementComments)
		.set({ authorMembershipId: null })
		.where(inArray(announcementComments.authorMembershipId, membershipIds));
	await tx
		.update(announcementComments)
		.set({
			mentions: sql`array(select x from unnest(${announcementComments.mentions}) x where x <> all(${uuids(membershipIds)}))`
		})
		.where(sql`${announcementComments.mentions} && ${uuids(membershipIds)}`);
	await tx.delete(announcementReactions).where(inArray(announcementReactions.membershipId, membershipIds));
}
