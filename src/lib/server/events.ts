import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { moduleOn } from '../modules';
import { audienceFilter } from './announcements';
import { addDays } from './dates';
import { authPool } from './db';
import {
	branches,
	departments,
	EVENT_AUDIENCES,
	eventRsvps,
	events,
	memberships,
	RSVP_RESPONSES,
	tenants
} from './db/schema';
import { AppError } from './errors';
import { claimDay, tenantToday } from './lifecycle';
import { log } from './log';
import { moduleOverrides } from './modules';
import { notify, sendAll } from './notifications';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const EVENT_MAX_SPAN_DAYS = 31;

const optionalId = z
	.union([z.literal(''), z.uuid()])
	.transform((v) => v || null)
	.prefault('');
const optionalTime = (message: string) =>
	z
		.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, message)])
		.transform((v) => v || null)
		.prefault('');
const dayDiff = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

export const eventSchema = z
	.object({
		title: z.string().trim().min(1, 'Add a title.').max(160, 'Keep the title under 160 characters.'),
		description: z.string().trim().max(2000, 'Keep the description under 2000 characters.').prefault(''),
		location: z.string().trim().max(200, 'Keep the location under 200 characters.').prefault(''),
		startDate: z.iso.date('Enter the start date.'),
		endDate: z
			.union([z.literal(''), z.iso.date('Enter a real end date.')])
			.transform((v) => v || null)
			.prefault(''),
		startTime: optionalTime('Enter a real start time.'),
		endTime: optionalTime('Enter a real end time.'),
		audience: z.enum(EVENT_AUDIENCES, 'Choose who is invited.'),
		departmentId: optionalId,
		branchId: optionalId
	})
	.transform((v) => ({ ...v, endDate: v.endDate ?? v.startDate }))
	.refine((v) => v.endDate >= v.startDate, { message: 'The event cannot end before it starts.' })
	.refine((v) => dayDiff(v.startDate, v.endDate) <= EVENT_MAX_SPAN_DAYS, {
		message: `An event can last at most ${EVENT_MAX_SPAN_DAYS + 1} days.`
	})
	.refine((v) => !v.startTime === !v.endTime, {
		message: 'Enter both a start and an end time, or neither for an all-day event.'
	})
	.refine((v) => !v.startTime || v.endDate > v.startDate || v.endTime! > v.startTime, {
		message: 'The event must end after it starts.'
	})
	.refine((v) => v.audience !== 'department' || v.departmentId, { message: 'Choose the department.' })
	.refine((v) => v.audience !== 'branch' || v.branchId, { message: 'Choose the branch.' })
	.transform((v) => ({
		...v,
		departmentId: v.audience === 'department' ? v.departmentId : null,
		branchId: v.audience === 'branch' ? v.branchId : null
	}));

export const canRunEvents = (access: Access) => scopesOf(access, 'event.manage').includes('all');
const onlyManagers = (access: Access) => {
	if (!canRunEvents(access)) throw new AppError('forbidden', 'Only people who manage events can do that.', 403);
};
const notFound = () => new AppError('not_found', 'That event does not exist.', 404);

const visibleTo = async (tx: Tx, access: Access) =>
	canRunEvents(access) ? undefined : audienceFilter(tx, access.employeeId, events);

export async function saveEvent(m: Member, raw: Record<string, string>) {
	const input = eventSchema.parse(raw);
	onlyManagers(m.access);
	return withTenant(userCtx(m), async (tx) => {
		if (input.startDate < (await tenantToday(tx)))
			throw new AppError('past_event', 'An event cannot start in the past.', 400);
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
		const [e] = await tx
			.insert(events)
			.values({ tenantId: m.tenant.id, ...input, createdByUserId: m.user.userId })
			.returning({ id: events.id });
		return e.id;
	});
}

export async function deleteEvent(m: Member, raw: Record<string, string>) {
	const id = z.uuid({ error: 'Choose an event.' }).parse(raw.eventId);
	onlyManagers(m.access);
	await withTenant(userCtx(m), async (tx) => {
		const gone = await tx.delete(events).where(eq(events.id, id)).returning({ id: events.id });
		if (!gone.length) throw notFound();
	});
}

const rsvpSchema = z.object({
	eventId: z.uuid({ error: 'Choose an event.' }),
	response: z.enum(RSVP_RESPONSES, 'Choose yes, no or maybe.')
});

export async function rsvpEvent(m: Member, raw: Record<string, string>) {
	const input = rsvpSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const today = await tenantToday(tx);
		const [e] = await tx
			.select({ id: events.id })
			.from(events)
			.where(and(eq(events.id, input.eventId), gte(events.endDate, today), await visibleTo(tx, m.access)));
		if (!e) throw notFound();
		await tx
			.insert(eventRsvps)
			.values({ tenantId: m.tenant.id, eventId: e.id, membershipId: m.access.membershipId, response: input.response })
			.onConflictDoUpdate({
				target: [eventRsvps.tenantId, eventRsvps.eventId, eventRsvps.membershipId],
				set: { response: input.response }
			});
	});
}

const eventFields = {
	id: events.id,
	title: events.title,
	description: events.description,
	location: events.location,
	startDate: events.startDate,
	endDate: events.endDate,
	startTime: sql<string | null>`to_char(${events.startTime}, 'HH24:MI')`,
	endTime: sql<string | null>`to_char(${events.endTime}, 'HH24:MI')`,
	audience: events.audience,
	departmentId: events.departmentId,
	branchId: events.branchId
};

export async function eventsBetween(tx: Tx, access: Access, from: string, to: string) {
	if (!moduleOn(await moduleOverrides(tx), 'events')) return [];
	return tx
		.select(eventFields)
		.from(events)
		.where(and(lte(events.startDate, to), gte(events.endDate, from), await visibleTo(tx, access)))
		.orderBy(asc(events.startDate), asc(events.startTime), asc(events.title))
		.limit(500);
}

export async function listedEvents(tx: Tx, access: Access, today: string) {
	const manager = canRunEvents(access);
	return and(gte(events.endDate, manager ? addDays(today, -90) : today), await visibleTo(tx, access));
}

export async function eventsPage(tx: Tx, access: Access) {
	const today = await tenantToday(tx);
	const manager = canRunEvents(access);
	const rows = await tx
		.select({
			...eventFields,
			target: sql<string | null>`coalesce(${departments.name}, ${branches.name})`,
			mine: sql<
				string | null
			>`(select r.response from event_rsvps r where r.event_id = ${events.id} and r.membership_id = ${access.membershipId}::uuid)`,
			going: sql<number>`(select count(*)::int from event_rsvps r where r.event_id = ${events.id} and r.response = 'yes')`
		})
		.from(events)
		.leftJoin(departments, eq(departments.id, events.departmentId))
		.leftJoin(branches, eq(branches.id, events.branchId))
		.where(await listedEvents(tx, access, today))
		.orderBy(
			sql`${events.endDate} < ${today}`,
			sql`case when ${events.endDate} < ${today} then ${events.startDate} end desc`,
			asc(events.startDate),
			asc(events.startTime),
			desc(events.createdAt)
		)
		.limit(200);
	const [d, b] = manager
		? await Promise.all([
				tx.select({ id: departments.id, name: departments.name }).from(departments).orderBy(departments.name),
				tx.select({ id: branches.id, name: branches.name }).from(branches).orderBy(branches.name)
			])
		: [[], []];
	return { today, manager, rows: rows.map((r) => ({ ...r, past: r.endDate < today })), departments: d, branches: b };
}

export async function remindEvents(tenantId: string, slug: string) {
	const mails = await withTenant(systemCtx(tenantId), async (tx) => {
		const today = await tenantToday(tx);
		if (!moduleOn(await moduleOverrides(tx), 'events')) return [];
		if (!(await claimDay(tx, tenantId, 'event_reminders_day', today))) return [];
		const tomorrow = addDays(today, 1);
		const due = await tx
			.select({ id: events.id, title: events.title, startTime: eventFields.startTime })
			.from(events)
			.where(eq(events.startDate, tomorrow));
		if (!due.length) return [];
		const going = await tx
			.select({ eventId: eventRsvps.eventId, membershipId: eventRsvps.membershipId })
			.from(eventRsvps)
			.innerJoin(memberships, eq(memberships.id, eventRsvps.membershipId))
			.where(
				and(
					inArray(
						eventRsvps.eventId,
						due.map((e) => e.id)
					),
					eq(eventRsvps.response, 'yes'),
					eq(memberships.status, 'active')
				)
			);
		const sent = await Promise.all(
			due.map((e) =>
				notify(
					tx,
					tenantId,
					going.filter((g) => g.eventId === e.id).map((g) => g.membershipId),
					{
						category: 'events',
						title: `Tomorrow: ${e.title}`,
						body: e.startTime ? `Starts at ${e.startTime}.` : 'All day.',
						link: 'events'
					},
					slug
				)
			)
		);
		return sent.flat();
	});
	await sendAll(mails);
}

export async function runEventReminders() {
	const list = await authPool()
		.db.select({ id: tenants.id, slug: tenants.slug })
		.from(tenants)
		.where(eq(tenants.status, 'active'));
	await list.reduce<Promise<void>>(
		(prior, t) =>
			prior.then(() =>
				remindEvents(t.id, t.slug).catch((err) =>
					log.error({ tenantId: t.id, err: (err as Error).message }, 'event reminders failed')
				)
			),
		Promise.resolve()
	);
}
