import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { memberNames } from './audience';
import { kudos, kudosRecipients, tenantSettings } from './db/schema';
import { AppError } from './errors';
import type { Mail } from './mail';
import { notify, sendAll } from './notifications';
import { hitOrLocal } from './ratelimit';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const KUDOS_PER_DAY = 20;
export const KUDOS_MAX_RECIPIENTS = 10;
export const KUDOS_MAX_VALUES = 20;
export const KUDOS_CHART_MONTHS = 6;
const WALL_SIZE = 50;
const FORMER = 'Former employee';
const NUL = 'Remove unsupported characters.';
const noNul = (v: string) => !v.includes('\0');

export const canModerateKudos = (access: Access) => scopesOf(access, 'kudos.moderate').includes('all');
const onlyModerators = (access: Access) => {
	if (!canModerateKudos(access)) throw new AppError('forbidden', 'Only people who moderate kudos can do that.', 403);
};

const kudosSchema = z.object({
	message: z
		.string('Write a message.')
		.trim()
		.min(1, 'Write a message.')
		.max(500, 'Keep the message under 500 characters.')
		.refine(noNul, NUL),
	valueTag: z.string().trim().prefault(''),
	recipients: z
		.array(z.uuid('Choose people from the list.'), 'Choose who to thank.')
		.min(1, 'Choose who to thank.')
		.max(KUDOS_MAX_RECIPIENTS, `Thank at most ${KUDOS_MAX_RECIPIENTS} people at once.`)
		.transform((ids) => [...new Set(ids)])
});

const valuesSchema = z
	.string()
	.prefault('')
	.transform((v) =>
		v
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
	)
	.pipe(
		z
			.array(
				z.string().max(40, 'Keep each value under 40 characters.').refine(noNul, NUL),
				'List the values, one per line.'
			)
			.max(KUDOS_MAX_VALUES, `List at most ${KUDOS_MAX_VALUES} values.`)
	)
	.refine((v) => new Set(v.map((x) => x.toLowerCase())).size === v.length, { message: 'Each value must differ.' });

const activePeople = async (tx: Tx, ids: string[]) => {
	const rows = await tx.execute<{ id: string; name: string }>(sql`
		select membership_id as id, name from tenant_users
		where membership_status = 'active' and user_status = 'active' and membership_id in ${ids}`);
	return new Map(rows.map((r) => [r.id, r.name]));
};

const kudosValues = async (tx: Tx) =>
	(await tx.select({ values: tenantSettings.kudosValues }).from(tenantSettings))[0]?.values ?? [];

export async function giveKudos(m: Member, raw: { message?: string; valueTag?: string; recipients: string[] }) {
	const input = kudosSchema.parse(raw);
	const me = m.access.membershipId;
	if (input.recipients.includes(me)) throw new AppError('self', 'You cannot give kudos to yourself.', 400);
	let mails: Mail[] = [];
	await withTenant(userCtx(m), async (tx) => {
		const people = await activePeople(tx, [me, ...input.recipients]);
		if (!people.has(me)) throw new AppError('forbidden', 'Only active members can give kudos.', 403);
		if (input.recipients.some((id) => !people.has(id)))
			throw new AppError('invalid_recipient', 'Choose people from the list.', 400);
		const values = await kudosValues(tx);
		const valueTag = input.valueTag ? values.find((v) => v.toLowerCase() === input.valueTag.toLowerCase()) : null;
		if (valueTag === undefined) throw new AppError('invalid_value', 'Choose one of the listed values.', 400);
		const limited = await hitOrLocal('kudos', me, KUDOS_PER_DAY, 86_400_000);
		if (!limited.ok)
			throw new AppError('too_many', `You can give kudos ${KUDOS_PER_DAY} times a day. Try again tomorrow.`, 429);
		const [k] = await tx
			.insert(kudos)
			.values({ tenantId: m.tenant.id, fromMembershipId: me, message: input.message, valueTag })
			.returning({ id: kudos.id });
		await tx
			.insert(kudosRecipients)
			.values(input.recipients.map((membershipId) => ({ tenantId: m.tenant.id, kudosId: k.id, membershipId })));
		mails = await notify(
			tx,
			m.tenant.id,
			input.recipients,
			{
				category: 'kudos',
				title: `${people.get(me)} gave you kudos`,
				body: 'Open the kudos wall to read the message.',
				link: 'kudos'
			},
			m.tenant.slug
		);
	});
	await sendAll(mails);
}

export async function kudosWall(tx: Tx, access: Access, limit = WALL_SIZE, withHidden = true) {
	const moderator = withHidden && canModerateKudos(access);
	const rows = await tx
		.select({
			id: kudos.id,
			from: kudos.fromMembershipId,
			message: kudos.message,
			valueTag: kudos.valueTag,
			createdAt: kudos.createdAt,
			hidden: sql<boolean>`${kudos.hiddenAt} is not null`
		})
		.from(kudos)
		.where(moderator ? undefined : isNull(kudos.hiddenAt))
		.orderBy(desc(kudos.createdAt))
		.limit(limit);
	const recipients = rows.length
		? await tx
				.select({ kudosId: kudosRecipients.kudosId, membershipId: kudosRecipients.membershipId })
				.from(kudosRecipients)
				.where(
					inArray(
						kudosRecipients.kudosId,
						rows.map((r) => r.id)
					)
				)
		: [];
	const names = await memberNames(tx, [
		...new Set([...rows.flatMap((r) => (r.from ? [r.from] : [])), ...recipients.map((r) => r.membershipId)])
	]);
	return rows.map((r) => ({
		...r,
		from: r.from ? (names.get(r.from) ?? FORMER) : FORMER,
		to: recipients
			.filter((x) => x.kudosId === r.id)
			.map((x) => names.get(x.membershipId) ?? FORMER)
			.sort((a, b) => a.localeCompare(b))
	}));
}

const tenantZone = sql`coalesce((select s.timezone from tenant_settings s), 'UTC')`;

export async function kudosMonths(tx: Tx) {
	const rows = await tx
		.select({
			month: sql<string>`to_char(${kudos.createdAt} at time zone ${tenantZone}, 'YYYY-MM')`,
			value: kudos.valueTag,
			n: sql<number>`count(*)::int`
		})
		.from(kudos)
		.where(
			and(
				isNull(kudos.hiddenAt),
				gte(
					kudos.createdAt,
					sql`(date_trunc('month', now() at time zone ${tenantZone}) - make_interval(months => ${KUDOS_CHART_MONTHS - 1})) at time zone ${tenantZone}`
				)
			)
		)
		.groupBy(sql`1`, kudos.valueTag)
		.orderBy(sql`1`);
	const months = [...new Set(rows.map((r) => r.month))];
	const values = [...new Set(rows.map((r) => r.value ?? 'No value'))].sort((a, b) => a.localeCompare(b));
	return {
		values,
		months: months.map((month) => ({
			month,
			counts: values.map((v) =>
				rows.filter((r) => r.month === month && (r.value ?? 'No value') === v).reduce((sum, r) => sum + r.n, 0)
			)
		}))
	};
}

export async function kudosPage(tx: Tx, access: Access) {
	const people = await tx.execute<{ id: string; name: string }>(sql`
		select membership_id as id, name from tenant_users
		where membership_status = 'active' and user_status = 'active' and membership_id <> ${access.membershipId}::uuid
		order by name limit 5000`);
	return {
		moderator: canModerateKudos(access),
		wall: await kudosWall(tx, access),
		chart: await kudosMonths(tx),
		values: await kudosValues(tx),
		people: [...people]
	};
}

export async function hideKudos(m: Member, id: string, hidden: boolean) {
	onlyModerators(m.access);
	const kid = z.uuid({ error: 'Choose kudos.' }).parse(id);
	await withTenant(userCtx(m), async (tx) => {
		const [k] = await tx
			.update(kudos)
			.set(hidden ? { hiddenAt: new Date(), hiddenByUserId: m.user.userId } : { hiddenAt: null, hiddenByUserId: null })
			.where(eq(kudos.id, kid))
			.returning({ id: kudos.id });
		if (!k) throw new AppError('not_found', 'Those kudos do not exist.', 404);
	});
}

export async function saveKudosValues(m: Member, raw: string) {
	onlyModerators(m.access);
	const values = valuesSchema.parse(raw);
	await withTenant(userCtx(m), (tx) => tx.update(tenantSettings).set({ kudosValues: values }));
}

export async function forgetKudos(tx: Tx, membershipIds: string[]) {
	if (!membershipIds.length) return;
	await tx.update(kudos).set({ fromMembershipId: null }).where(inArray(kudos.fromMembershipId, membershipIds));
	const left = await tx
		.delete(kudosRecipients)
		.where(inArray(kudosRecipients.membershipId, membershipIds))
		.returning({ kudosId: kudosRecipients.kudosId });
	if (!left.length) return;
	await tx
		.delete(kudos)
		.where(
			and(
				inArray(kudos.id, [...new Set(left.map((r) => r.kudosId))]),
				sql`not exists (select 1 from kudos_recipients r where r.kudos_id = ${kudos.id})`
			)
		);
}
