import { and, asc, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { icsCalendar, type IcsEvent } from '../ics';
import { moduleOn } from '../modules';
import { randomToken, sha256 } from './auth/crypto';
import { now } from './clock';
import { addDays, addMonths, zonedUtc } from './dates';
import {
	calendarFeeds,
	employees,
	holidays,
	leaveRequestDays,
	leaveRequests,
	leaveTypes,
	rosterEntries,
	shifts,
	tenantSettings
} from './db/schema';
import { eventsBetween } from './events';
import { tenantToday, tenantWeeks } from './lifecycle';
import { advisoryLock, LOCK } from './locks';
import { log } from './log';
import { moduleOverrides } from './modules';
import type { TokenHolder } from './public/tokens';
import { loadAccess, userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const CALENDAR_ROW_CAP = 20_000;
export const FEED_DAYS_BACK = 60;
export const FEED_DAYS_AHEAD = 180;
const MONTH = /^(19|20)\d{2}-(0[1-9]|1[0-2])$/;

export type CalendarEntry = {
	date: string;
	session: string;
	employeeId: string;
	name: string;
	type: string;
	shiftStart: string | null;
	shiftEnd: string | null;
};

const shiftTime = (column: 'start_time' | 'end_time') =>
	sql<string | null>`to_char(coalesce(
		(select s.${sql.raw(column)} from shift_assignments a join shifts s on s.id = a.shift_id
			where a.employee_id = "leave_request_days"."employee_id" and a.effective_from <= "leave_request_days"."date"
			order by a.effective_from desc limit 1),
		(select s.${sql.raw(column)} from shifts s where s.is_default)), 'HH24:MI')`;

export async function calendarEntries(
	tx: Tx,
	access: Access,
	from: string,
	to: string,
	opts: { otherLeaveAsOut?: boolean; shiftTimes?: boolean; cap?: number } = {}
): Promise<{ rows: CalendarEntry[]; truncated: boolean }> {
	const cap = opts.cap ?? CALENDAR_ROW_CAP;
	const [seen, detail] = await Promise.all([
		resolveScope(tx, access, 'employee.read'),
		resolveScope(tx, access, 'leave.read')
	]);
	const [me] = access.employeeId
		? await tx.select({ dept: employees.departmentId }).from(employees).where(eq(employees.id, access.employeeId))
		: [];
	const rows = await tx
		.select({
			date: leaveRequestDays.date,
			session: leaveRequestDays.session,
			employeeId: employees.id,
			name: employees.fullName,
			type: leaveTypes.name,
			shiftStart: opts.shiftTimes ? shiftTime('start_time') : sql<null>`null`,
			shiftEnd: opts.shiftTimes ? shiftTime('end_time') : sql<null>`null`
		})
		.from(leaveRequestDays)
		.innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
		.innerJoin(employees, eq(employees.id, leaveRequestDays.employeeId))
		.innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
		.where(
			and(
				eq(leaveRequestDays.status, 'approved'),
				gte(leaveRequestDays.date, from),
				lte(leaveRequestDays.date, to),
				ne(employees.status, 'exited'),
				me?.dept
					? or(scopeWhere(seen, employees.id), eq(employees.departmentId, me.dept))
					: scopeWhere(seen, employees.id)
			)
		)
		.orderBy(asc(leaveRequestDays.date), asc(employees.fullName), asc(leaveRequestDays.session))
		.limit(cap + 1);
	const truncated = rows.length > cap;
	if (truncated) log.warn({ membershipId: access.membershipId, from, to }, 'calendar entries truncated');
	const showType = (id: string) =>
		opts.otherLeaveAsOut ? id === access.employeeId : inScope(detail, id) || id === access.employeeId;
	return {
		rows: rows.slice(0, cap).map((r) => ({ ...r, type: showType(r.employeeId) ? r.type : 'Out' })),
		truncated
	};
}

export const holidaysBetween = (tx: Tx, from: string, to: string) =>
	tx
		.select({ id: holidays.id, date: holidays.date, name: holidays.name })
		.from(holidays)
		.where(and(gte(holidays.date, from), lte(holidays.date, to)))
		.orderBy(asc(holidays.date));

async function myShifts(tx: Tx, access: Access, from: string, to: string) {
	if (!access.employeeId || !moduleOn(await moduleOverrides(tx), 'schedule')) return [];
	return tx
		.select({
			id: rosterEntries.id,
			date: rosterEntries.date,
			name: shifts.name,
			start: sql<string>`to_char(${shifts.startTime}, 'HH24:MI')`,
			end: sql<string>`to_char(${shifts.endTime}, 'HH24:MI')`
		})
		.from(rosterEntries)
		.innerJoin(shifts, eq(shifts.id, rosterEntries.shiftId))
		.where(
			and(
				eq(rosterEntries.employeeId, access.employeeId),
				eq(rosterEntries.status, 'published'),
				eq(rosterEntries.kind, 'work'),
				gte(rosterEntries.date, from),
				lte(rosterEntries.date, to)
			)
		)
		.orderBy(asc(rosterEntries.date));
}

const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

export async function calendarMonth(tx: Tx, access: Access, raw: string | null) {
	const weeks = await tenantWeeks(tx);
	const month = raw && MONTH.test(raw) ? raw : weeks.today.slice(0, 7);
	const first = `${month}-01`;
	const last = addDays(`${addMonths(month, 1)}-01`, -1);
	const start = weeks.of(first);
	const dates = Array.from({ length: Math.ceil((daysBetween(start, last) + 1) / 7) * 7 }, (_, i) => addDays(start, i));
	const end = dates.at(-1)!;
	const [leave, holidayRows, eventRows, shiftRows] = await Promise.all([
		calendarEntries(tx, access, start, end),
		holidaysBetween(tx, start, end),
		eventsBetween(tx, access, start, end),
		myShifts(tx, access, start, end)
	]);
	const byDate = <T extends { date: string }>(rows: T[]) =>
		rows.reduce((acc, r) => acc.set(r.date, [...(acc.get(r.date) ?? []), r]), new Map<string, T[]>());
	const out = byDate(leave.rows);
	const hol = byDate(holidayRows);
	const mine = byDate(shiftRows);
	return {
		month,
		today: weeks.today,
		prev: addMonths(month, -1),
		next: addMonths(month, 1),
		truncated: leave.truncated,
		days: dates.map((date) => ({
			date,
			inMonth: date.startsWith(month),
			out: (out.get(date) ?? []).map(({ name, type, session }) => ({ name, type, session })),
			holidays: (hol.get(date) ?? []).map((h) => h.name),
			shifts: (mine.get(date) ?? []).map(({ name, start, end }) => ({ name, start, end })),
			events: eventRows
				.filter((e) => e.startDate <= date && e.endDate >= date)
				.map((e) => ({ id: e.id, title: e.title, startTime: e.startTime }))
		}))
	};
}

export async function feedStatus(tx: Tx, membershipId: string) {
	const [row] = await tx
		.select({
			prefix: calendarFeeds.tokenPrefix,
			createdAt: calendarFeeds.createdAt,
			lastUsedAt: calendarFeeds.lastUsedAt
		})
		.from(calendarFeeds)
		.where(and(eq(calendarFeeds.membershipId, membershipId), isNull(calendarFeeds.revokedAt)));
	return row ?? null;
}

export async function issueFeed(m: Member): Promise<string> {
	const token = randomToken();
	await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.calendarFeed, m.access.membershipId);
		await tx
			.update(calendarFeeds)
			.set({ revokedAt: now() })
			.where(and(eq(calendarFeeds.membershipId, m.access.membershipId), isNull(calendarFeeds.revokedAt)));
		await tx.insert(calendarFeeds).values({
			tenantId: m.tenant.id,
			membershipId: m.access.membershipId,
			tokenHash: sha256(token),
			tokenPrefix: token.slice(0, 6)
		});
	});
	return token;
}

export async function revokeFeed(m: Member): Promise<void> {
	await withTenant(userCtx(m), (tx) =>
		tx
			.update(calendarFeeds)
			.set({ revokedAt: now() })
			.where(and(eq(calendarFeeds.membershipId, m.access.membershipId), isNull(calendarFeeds.revokedAt)))
	);
}

const SESSION_LABEL: Record<string, string> = { am: 'morning', pm: 'afternoon' };
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function halfDay(e: CalendarEntry, zone: string): IcsEvent['start'][] | null {
	if (e.session === 'full' || !e.shiftStart || !e.shiftEnd) return null;
	const start = minutes(e.shiftStart);
	const span = (minutes(e.shiftEnd) - start + 1440) % 1440 || 1440;
	const at = (offset: number) => {
		const total = start + offset;
		return { utc: zonedUtc(addDays(e.date, Math.floor(total / 1440)), clock(total % 1440), zone).toISOString() };
	};
	const half = Math.floor(span / 2);
	return e.session === 'am' ? [at(0), at(half)] : [at(half), at(span)];
}

export async function feedIcs(holder: TokenHolder): Promise<string | null> {
	const access = await loadAccess(holder.tenantId, {
		id: holder.membershipId,
		status: 'active',
		employeeId: holder.employeeId
	});
	const ctx = {
		tenantId: holder.tenantId,
		userId: holder.userId,
		employeeId: holder.employeeId,
		actor: 'user' as const
	};
	return withTenant(ctx, async (tx) => {
		if (!moduleOn(await moduleOverrides(tx), 'calendar')) return null;
		const [s] = await tx.select({ tz: tenantSettings.timezone }).from(tenantSettings);
		const zone = s?.tz ?? 'UTC';
		const today = await tenantToday(tx);
		const from = addDays(today, -FEED_DAYS_BACK);
		const to = addDays(today, FEED_DAYS_AHEAD);
		const [leave, holidayRows, eventRows, shiftRows] = await Promise.all([
			calendarEntries(tx, access, from, to, { otherLeaveAsOut: true, shiftTimes: true }),
			holidaysBetween(tx, from, to),
			eventsBetween(tx, access, from, to),
			myShifts(tx, access, from, to)
		]);
		await tx
			.update(calendarFeeds)
			.set({ lastUsedAt: now() })
			.where(
				and(
					eq(calendarFeeds.id, holder.tokenId),
					or(isNull(calendarFeeds.lastUsedAt), sql`${calendarFeeds.lastUsedAt} < now() - interval '1 day'`)
				)
			);
		const items: IcsEvent[] = [
			...leave.rows.map((e) => {
				const times = halfDay(e, zone);
				const part = e.session === 'full' || times ? '' : ` (${SESSION_LABEL[e.session]})`;
				return {
					uid: `leave-${e.employeeId}-${e.date}-${e.session}@hrms-pro`,
					summary: `${e.name}: ${e.type}${part}`,
					start: times?.[0] ?? { date: e.date },
					end: times?.[1] ?? { date: addDays(e.date, 1) }
				};
			}),
			...holidayRows.map((h) => ({
				uid: `holiday-${h.id}@hrms-pro`,
				summary: `Holiday: ${h.name}`,
				start: { date: h.date },
				end: { date: addDays(h.date, 1) }
			})),
			...eventRows.map((e) => ({
				uid: `event-${e.id}@hrms-pro`,
				summary: e.title,
				description: e.description || undefined,
				location: e.location || undefined,
				start: e.startTime ? { utc: zonedUtc(e.startDate, e.startTime, zone).toISOString() } : { date: e.startDate },
				end: e.endTime ? { utc: zonedUtc(e.endDate, e.endTime, zone).toISOString() } : { date: addDays(e.endDate, 1) }
			})),
			...shiftRows.map((r) => ({
				uid: `shift-${r.id}@hrms-pro`,
				summary: `Shift: ${r.name} ${r.start}–${r.end}`,
				start: { utc: zonedUtc(r.date, r.start, zone).toISOString() },
				end: { utc: zonedUtc(r.end <= r.start ? addDays(r.date, 1) : r.date, r.end, zone).toISOString() }
			}))
		];
		return icsCalendar(`${holder.tenantName} team calendar`, now(), items);
	});
}
