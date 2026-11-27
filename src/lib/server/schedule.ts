import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recomputeAttendance } from './attendance';
import { addDays } from './dates';
import {
	availability,
	employees,
	holidays,
	leaveRequestDays,
	memberships,
	rosterEntries,
	shifts,
	shiftSwaps
} from './db/schema';
import { lockEmployee } from './employees';
import { AppError } from './errors';
import { tenantWeeks } from './lifecycle';
import { advisoryLock, LOCK } from './locks';
import { notify, sendAll } from './notifications';
import { payrollClosedMonths } from './payroll';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere, type ScopeSet } from './rbac/scope';
import { dayRules } from './rest-days';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Entry = typeof rosterEntries.$inferSelect;

const MAX_PEOPLE = 300;
const MAX_AVAILABILITY = 50;
const ACTIVE_LEAVE = ['pending', 'approved'];

export const hhmm = (t: string) => t.slice(0, 5);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const span = (from: string) => Array.from({ length: 7 }, (_, i) => addDays(from, i));
const overlaps = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from < b.to && b.from < a.to;
const inRange = (d: string) => d >= '2000-01-01' && d <= '2099-12-31';
export const isoDay = (message: string) => z.iso.date(message).refine(inRange, message);
export const note = z
	.string()
	.trim()
	.max(200, 'Keep the note under 200 characters.')
	.refine((v) => [...v].every((c) => c >= ' ' && c !== '\u007f'), 'Remove control characters from the note.')
	.optional()
	.transform((v) => v || null);

export async function weekStart(tx: Tx, raw?: string | null) {
	const weeks = await tenantWeeks(tx);
	const asked = isoDay('Choose a week.').safeParse(raw);
	return { start: weeks.of(asked.success ? asked.data : weeks.today), today: weeks.today };
}

const employedIn = (from: string, to: string) =>
	and(
		lte(employees.joinDate, to),
		or(isNull(employees.exitDate), gte(employees.exitDate, from)),
		or(ne(employees.status, 'exited'), gte(employees.exitDate, from))
	);

export async function leaveDays(tx: Tx, employeeIds: string[], from: string, to: string) {
	if (!employeeIds.length) return new Map<string, string>();
	const rows = await tx
		.select({ employeeId: leaveRequestDays.employeeId, date: leaveRequestDays.date, status: leaveRequestDays.status })
		.from(leaveRequestDays)
		.where(
			and(
				inArray(leaveRequestDays.employeeId, employeeIds),
				inArray(leaveRequestDays.status, ACTIVE_LEAVE),
				gte(leaveRequestDays.date, from),
				lte(leaveRequestDays.date, to)
			)
		);
	return new Map(rows.map((r) => [`${r.employeeId}:${r.date}`, r.status]));
}

async function unavailable(tx: Tx, employeeIds: string[], dates: string[]) {
	if (!employeeIds.length) return () => [];
	const rows = await tx
		.select()
		.from(availability)
		.where(
			and(
				inArray(availability.employeeId, employeeIds),
				or(isNull(availability.date), inArray(availability.date, dates))
			)
		);
	const byEmployee = Map.groupBy(rows, (r) => r.employeeId);
	return (employeeId: string, date: string) =>
		(byEmployee.get(employeeId) ?? [])
			.filter((r) => r.date === date || r.weekday === weekday(date))
			.map((r) => ({ from: hhmm(r.fromTime), to: hhmm(r.toTime), note: r.note }));
}

export async function scheduleWeek(tx: Tx, access: Access, rawWeek?: string | null) {
	const { start, today } = await weekStart(tx, rawWeek);
	const dates = span(start);
	const end = dates[6];
	const read = await resolveScope(tx, access, 'schedule.read');
	const manage = await resolveScope(tx, access, 'schedule.manage');
	const people = await tx
		.select({ id: employees.id, code: employees.code, name: employees.fullName })
		.from(employees)
		.where(and(employedIn(start, end), scopeWhere(read, employees.id)))
		.orderBy(asc(employees.fullName), asc(employees.code))
		.limit(MAX_PEOPLE);
	const ids = people.map((p) => p.id);
	const entries = ids.length
		? await tx
				.select()
				.from(rosterEntries)
				.where(
					and(inArray(rosterEntries.employeeId, ids), gte(rosterEntries.date, start), lte(rosterEntries.date, end))
				)
		: [];
	const allShifts = await tx.select().from(shifts).orderBy(asc(shifts.name));
	const shiftName = new Map(allShifts.map((s) => [s.id, `${s.name} ${hhmm(s.startTime)}–${hhmm(s.endTime)}`]));
	const rule = await dayRules(tx, ids, start, end);
	const off = new Map(
		(
			await tx
				.select({ date: holidays.date, name: holidays.name })
				.from(holidays)
				.where(and(gte(holidays.date, start), lte(holidays.date, end)))
		).map((h) => [h.date, h.name])
	);
	const leave = await leaveDays(tx, ids, start, end);
	const managed = ids.filter((id) => inScope(manage, id));
	const busy = await unavailable(
		tx,
		[...new Set([...managed, ...(access.employeeId ? [access.employeeId] : [])])],
		[...dates, addDays(end, 1)]
	);
	const clash = (employeeId: string, date: string, s: { startTime: string; endTime: string }) => {
		const [from, to] = [hhmm(s.startTime), hhmm(s.endTime)];
		const hits = (d: string, span: { from: string; to: string }) => busy(employeeId, d).some((b) => overlaps(b, span));
		return to > from
			? hits(date, { from, to })
			: hits(date, { from, to: '24:00' }) || hits(addDays(date, 1), { from: '00:00', to });
	};
	const shown = new Map(
		entries
			.filter((e) => e.status === 'published' || inScope(manage, e.employeeId!))
			.map((e) => [`${e.employeeId}:${e.date}`, e])
	);
	const shiftById = new Map(allShifts.map((s) => [s.id, s]));
	const rows = people.map((p) => {
		const canManage = inScope(manage, p.id);
		return {
			...p,
			canManage,
			cells: dates.map((date) => {
				const e = shown.get(`${p.id}:${date}`);
				const r = rule(p.id, date);
				const leaveStatus = leave.get(`${p.id}:${date}`) ?? null;
				const blocks = busy(p.id, date);
				const shift = e?.shiftId ? shiftById.get(e.shiftId) : undefined;
				const conflicts = [
					...(e?.kind === 'work' && leaveStatus ? ['On leave that day'] : []),
					...(e?.kind === 'work' && shift && clash(p.id, date, shift) ? ['Marked unavailable'] : [])
				];
				return {
					date,
					entry: e
						? {
								id: e.id,
								kind: e.kind,
								status: e.status,
								note: e.note,
								shiftId: e.shiftId,
								shift: e.shiftId ? (shiftName.get(e.shiftId) ?? '') : null
							}
						: null,
					rest: r.rest,
					usual: r.shift ? shiftName.get(r.shift.id) : null,
					leave: leaveStatus,
					unavailable: canManage || p.id === access.employeeId ? blocks : [],
					conflicts
				};
			})
		};
	});
	return {
		start,
		today,
		prev: addDays(start, -7),
		next: addDays(start, 7),
		days: dates.map((date) => ({ date, holiday: off.get(date) ?? null })),
		rows,
		truncated: people.length === MAX_PEOPLE,
		canManage: managed.length > 0,
		drafts: entries.filter((e) => e.status === 'draft' && inScope(manage, e.employeeId!)).length,
		shifts: allShifts.filter((s) => s.active).map((s) => ({ id: s.id, name: shiftName.get(s.id)! }))
	};
}

const entrySchema = z
	.object({
		employeeId: z.uuid({ error: 'Choose a person.' }),
		date: isoDay('Choose a day.'),
		kind: z.enum(['work', 'off'], { error: 'Choose work or day off.' }),
		shiftId: z.string().optional(),
		note
	})
	.transform((v) => ({ ...v, shiftId: v.kind === 'work' ? v.shiftId : undefined }))
	.refine((v) => v.kind === 'off' || z.uuid().safeParse(v.shiftId).success, {
		message: 'Choose a shift.',
		path: ['shiftId']
	});

async function managedEmployee(tx: Tx, m: Member, employeeId: string) {
	const e = await lockEmployee(tx, m.access, employeeId);
	if (!inScope(await resolveScope(tx, m.access, 'schedule.manage'), e.id))
		throw new AppError('forbidden', 'You cannot change the schedule for this person.', 403);
	return e;
}

export async function refuseClosed(tx: Tx, rows: { employeeId: string; date: string }[]) {
	const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))];
	const closed = await payrollClosedMonths(tx, [...new Set(rows.map((r) => r.employeeId))], months);
	const hit = rows.filter((r) => closed.has(`${r.employeeId}:${r.date.slice(0, 7)}`));
	if (hit.length)
		throw new AppError(
			'payroll_closed',
			`Payroll is already approved for ${[...new Set(hit.map((r) => r.date.slice(0, 7)))].sort().join(', ')}, so those days cannot change.`,
			409
		);
}

async function refuseLeave(tx: Tx, rows: { employeeId: string; date: string; kind: string; name?: string }[]) {
	const work = rows.filter((r) => r.kind === 'work');
	if (!work.length) return;
	const dates = work.map((r) => r.date).sort();
	const leave = await leaveDays(tx, [...new Set(work.map((r) => r.employeeId))], dates[0], dates[dates.length - 1]);
	const hit = work.filter((r) => leave.has(`${r.employeeId}:${r.date}`));
	if (hit.length)
		throw new AppError(
			'leave_conflict',
			`Leave already covers ${hit.map((r) => `${r.name ? `${r.name} on ` : ''}${r.date}`).join(', ')}. Change that leave or the schedule first.`,
			409
		);
}

export async function tell(tx: Tx, m: Member, employeeIds: string[], title: string, week: string) {
	if (!employeeIds.length) return [];
	const owners = await tx
		.select({ id: memberships.id })
		.from(memberships)
		.where(and(inArray(memberships.employeeId, employeeIds), eq(memberships.status, 'active')));
	return notify(
		tx,
		m.tenant.id,
		owners.map((o) => o.id),
		{ category: 'schedule', title, link: `schedule?week=${week}` },
		m.tenant.slug
	);
}

export async function refuseSwapping(tx: Tx, entryIds: string[]) {
	const [hit] = await tx
		.select({ id: shiftSwaps.id })
		.from(shiftSwaps)
		.where(
			and(
				inArray(shiftSwaps.status, ['asked', 'accepted']),
				or(inArray(shiftSwaps.requesterEntryId, entryIds), inArray(shiftSwaps.counterpartEntryId, entryIds))
			)
		)
		.limit(1);
	if (hit) throw new AppError('swap_pending', 'A swap is waiting on this shift. Decide or cancel the swap first.', 409);
}

export async function activeShift(tx: Tx, shiftId: string | undefined) {
	if (!shiftId) return null;
	const [s] = await tx.select().from(shifts).where(eq(shifts.id, shiftId));
	if (!s?.active) throw new AppError('unknown_shift', 'Choose an active shift.', 400);
	return s;
}

export async function saveEntry(m: Member, raw: Record<string, string>) {
	const input = entrySchema.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const e = await managedEmployee(tx, m, input.employeeId);
		if (input.date < e.joinDate || (e.exitDate && input.date > e.exitDate))
			throw new AppError('not_employed', 'That person is not employed on that day.', 400);
		const shift = await activeShift(tx, input.shiftId);
		await refuseClosed(tx, [{ employeeId: e.id, date: input.date }]);
		const [existing] = await tx
			.select()
			.from(rosterEntries)
			.where(and(eq(rosterEntries.employeeId, e.id), eq(rosterEntries.date, input.date)))
			.for('update');
		const published = existing?.status === 'published';
		if (existing) await refuseSwapping(tx, [existing.id]);
		if (published) await refuseLeave(tx, [{ employeeId: e.id, date: input.date, kind: input.kind }]);
		const values = {
			kind: input.kind,
			shiftId: shift?.id ?? null,
			note: input.note,
			createdByUserId: m.user.userId
		};
		if (existing) await tx.update(rosterEntries).set(values).where(eq(rosterEntries.id, existing.id));
		else
			await tx
				.insert(rosterEntries)
				.values({ tenantId: m.tenant.id, employeeId: e.id, date: input.date, status: 'draft', ...values });
		if (!published) return [];
		await recomputeAttendance(tx, m.tenant.id, input.date, input.date, [e.id]);
		const { start } = await weekStart(tx, input.date);
		return tell(tx, m, [e.id], `Your schedule changed for ${input.date}`, start);
	});
	await sendAll(mails);
}

export async function removeEntry(m: Member, entryId: string) {
	const id = z.uuid().safeParse(entryId);
	const mails = await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const [found] = id.success ? await tx.select().from(rosterEntries).where(eq(rosterEntries.id, id.data)) : [];
		if (!found?.employeeId) throw new AppError('not_found', 'That schedule entry does not exist.', 404);
		const e = await managedEmployee(tx, m, found.employeeId);
		const [entry] = await tx.select().from(rosterEntries).where(eq(rosterEntries.id, found.id)).for('update');
		if (!entry) throw new AppError('not_found', 'That schedule entry does not exist.', 404);
		await refuseSwapping(tx, [entry.id]);
		if (entry.status === 'published') await refuseClosed(tx, [{ employeeId: e.id, date: entry.date }]);
		await tx.delete(rosterEntries).where(eq(rosterEntries.id, entry.id));
		if (entry.status !== 'published') return [];
		await recomputeAttendance(tx, m.tenant.id, entry.date, entry.date, [e.id]);
		const { start } = await weekStart(tx, entry.date);
		return tell(tx, m, [e.id], `Your schedule changed for ${entry.date}`, start);
	});
	await sendAll(mails);
}

async function draftsIn(tx: Tx, manage: ScopeSet, from: string, to: string) {
	return tx
		.select({
			entry: rosterEntries,
			name: employees.fullName,
			joinDate: employees.joinDate,
			exitDate: employees.exitDate,
			exited: sql<boolean>`${employees.status} = 'exited'`,
			shiftActive: shifts.active
		})
		.from(rosterEntries)
		.innerJoin(employees, eq(employees.id, rosterEntries.employeeId))
		.leftJoin(shifts, eq(shifts.id, rosterEntries.shiftId))
		.where(
			and(
				eq(rosterEntries.status, 'draft'),
				gte(rosterEntries.date, from),
				lte(rosterEntries.date, to),
				scopeWhere(manage, rosterEntries.employeeId)
			)
		)
		.orderBy(asc(rosterEntries.date))
		.for('update', { of: rosterEntries });
}

export async function publishWeek(m: Member, rawWeek: string) {
	const result = await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const { start } = await weekStart(tx, rawWeek);
		const end = addDays(start, 6);
		const manage = await resolveScope(tx, m.access, 'schedule.manage');
		const drafts = await draftsIn(tx, manage, start, end);
		if (!drafts.length)
			throw new AppError('nothing_to_publish', 'There are no draft entries to publish this week.', 409);
		const rows = drafts.map((d) => ({
			employeeId: d.entry.employeeId!,
			date: d.entry.date,
			kind: d.entry.kind,
			name: d.name
		}));
		const list = (hit: typeof drafts) => hit.map((d) => `${d.name} on ${d.entry.date}`).join(', ');
		const retired = drafts.filter((d) => d.entry.kind === 'work' && !d.shiftActive);
		if (retired.length) throw new AppError('unknown_shift', `The shift is no longer active for ${list(retired)}.`, 409);
		const gone = drafts.filter(
			(d) => d.entry.date < d.joinDate || (d.exitDate && d.entry.date > d.exitDate) || (d.exited && !d.exitDate)
		);
		if (gone.length) throw new AppError('not_employed', `Not employed: ${list(gone)}. Remove those days first.`, 409);
		await refuseClosed(tx, rows);
		await refuseLeave(tx, rows);
		await tx
			.update(rosterEntries)
			.set({ status: 'published', publishedAt: new Date() })
			.where(
				inArray(
					rosterEntries.id,
					drafts.map((d) => d.entry.id)
				)
			);
		const ids = [...new Set(rows.map((r) => r.employeeId))];
		await recomputeAttendance(tx, m.tenant.id, rows[0].date, rows[rows.length - 1].date, ids);
		const rule = await dayRules(tx, ids, start, end);
		const noRest = drafts
			.filter((d, i, all) => all.findIndex((x) => x.entry.employeeId === d.entry.employeeId) === i)
			.filter((d) => !span(start).some((date) => rule(d.entry.employeeId!, date).rest))
			.map((d) => d.name);
		const mails = await tell(tx, m, ids, `Your schedule for the week of ${start} is published`, start);
		return { published: drafts.length, noRest, mails };
	});
	await sendAll(result.mails);
	return { published: result.published, noRest: result.noRest };
}

export async function copyWeek(m: Member, rawWeek: string) {
	return withTenant(userCtx(m), async (tx) => {
		const { start } = await weekStart(tx, rawWeek);
		const from = addDays(start, -7);
		const manage = await resolveScope(tx, m.access, 'schedule.manage');
		const source = await tx
			.select({ entry: rosterEntries, joinDate: employees.joinDate, exitDate: employees.exitDate })
			.from(rosterEntries)
			.innerJoin(employees, eq(employees.id, rosterEntries.employeeId))
			.where(
				and(
					gte(rosterEntries.date, from),
					lte(rosterEntries.date, addDays(from, 6)),
					scopeWhere(manage, rosterEntries.employeeId),
					ne(employees.status, 'exited')
				)
			);
		const live = new Set(
			(await tx.select({ id: shifts.id }).from(shifts).where(eq(shifts.active, true))).map((s) => s.id)
		);
		const rows = source
			.map(({ entry, joinDate, exitDate }) => ({ entry, date: addDays(entry.date, 7), joinDate, exitDate }))
			.filter((r) => r.date >= r.joinDate && (!r.exitDate || r.date <= r.exitDate))
			.filter((r) => r.entry.kind === 'off' || live.has(r.entry.shiftId!))
			.map((r) => ({
				tenantId: m.tenant.id,
				employeeId: r.entry.employeeId,
				date: r.date,
				kind: r.entry.kind,
				shiftId: r.entry.shiftId,
				note: r.entry.note,
				status: 'draft',
				createdByUserId: m.user.userId
			}));
		const closed = await payrollClosedMonths(
			tx,
			[...new Set(rows.map((r) => r.employeeId!))],
			[...new Set(rows.map((r) => r.date.slice(0, 7)))]
		);
		const open = rows.filter((r) => !closed.has(`${r.employeeId}:${r.date.slice(0, 7)}`));
		if (!open.length) return 0;
		const added = await tx
			.insert(rosterEntries)
			.values(open)
			.onConflictDoNothing({
				target: [rosterEntries.tenantId, rosterEntries.employeeId, rosterEntries.date],
				where: sql`${rosterEntries.employeeId} is not null`
			})
			.returning({ id: rosterEntries.id });
		return added.length;
	});
}

export async function myAvailability(tx: Tx, access: Access) {
	if (!access.employeeId) return null;
	return tx
		.select()
		.from(availability)
		.where(eq(availability.employeeId, access.employeeId))
		.orderBy(asc(availability.weekday), asc(availability.date), asc(availability.fromTime));
}

const clock = (message: string) => z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, message);
const availabilitySchema = z
	.object({
		when: z.enum(['weekday', 'date'], { error: 'Choose a weekday or a date.' }),
		weekday: z.string().optional(),
		date: z.string().optional(),
		fromTime: clock('Enter when you become unavailable.'),
		toTime: clock('Enter when you are available again.'),
		note
	})
	.refine((v) => v.fromTime < v.toTime, 'The end must be after the start.')
	.refine((v) => v.when !== 'weekday' || /^[0-6]$/.test(v.weekday ?? ''), {
		message: 'Choose a weekday.',
		path: ['weekday']
	})
	.refine((v) => v.when !== 'date' || isoDay('Choose a date.').safeParse(v.date).success, {
		message: 'Choose a date.',
		path: ['date']
	});

export async function addAvailability(m: Member, raw: Record<string, string>) {
	const input = availabilitySchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		if (!m.access.employeeId)
			throw new AppError('no_employee', 'Your account is not linked to an employee record.', 403);
		const e = await lockEmployee(tx, m.access, m.access.employeeId);
		const [{ n }] = await tx
			.select({ n: sql<number>`count(*)`.mapWith(Number) })
			.from(availability)
			.where(eq(availability.employeeId, e.id));
		if (n >= MAX_AVAILABILITY)
			throw new AppError('too_many', `Keep at most ${MAX_AVAILABILITY} unavailable times.`, 409);
		await tx.insert(availability).values({
			tenantId: m.tenant.id,
			employeeId: e.id,
			weekday: input.when === 'weekday' ? Number(input.weekday) : null,
			date: input.when === 'date' ? input.date! : null,
			fromTime: input.fromTime,
			toTime: input.toTime,
			note: input.note
		});
	});
}

export async function removeAvailability(m: Member, availabilityId: string) {
	const id = z.uuid().safeParse(availabilityId);
	await withTenant(userCtx(m), async (tx) => {
		const gone =
			id.success && m.access.employeeId
				? await tx
						.delete(availability)
						.where(and(eq(availability.id, id.data), eq(availability.employeeId, m.access.employeeId)))
						.returning({ id: availability.id })
				: [];
		if (!gone.length) throw new AppError('not_found', 'That unavailable time does not exist.', 404);
	});
}

export type ScheduleWeek = Awaited<ReturnType<typeof scheduleWeek>>;
export type { Entry };
