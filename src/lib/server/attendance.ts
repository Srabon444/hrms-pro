import { and, asc, eq, gte, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computeDay, shiftDayOf, shiftWindow, zonedInstant, type DayResult } from './attendance-day';
import { now } from './clock';
import { addDays, dateIn } from './dates';
import { authPool } from './db';
import {
	attendanceDays,
	attendancePunches,
	attendanceRequests,
	employees,
	holidays,
	leaveRequestDays,
	tenants,
	tenantSettings
} from './db/schema';
import { AppError } from './errors';
import { csvRecords, ImportFailed, type ImportRowError } from './csv';
import { lockEmployee } from './employees';
import { log } from './log';
import { payrollClosedMonths } from './payroll';
import { singleAdmin } from './approval-chain';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { systemCtx, withTenant, type Tx } from './tenancy';
import type { Shift } from './shifts';
import { dayRules } from './rest-days';
import { clientIp, matchSite, punchRule, type Point } from './work-sites';

type Member = ReturnType<typeof requireMember>;
type DayRow = typeof attendanceDays.$inferInsert;

export const employeeZone = sql<string>`coalesce((select b.timezone from branches b where b.id = employees.branch_id), (select s.timezone from tenant_settings s), 'UTC')`;

export async function calendar(tx: Tx, employeeId?: string | null) {
	const [s] = await tx
		.select({
			tz: employeeId
				? sql<string>`coalesce((select b.timezone from employees e join branches b on b.id = e.branch_id where e.id = ${employeeId}), tenant_settings.timezone)`
				: tenantSettings.timezone
		})
		.from(tenantSettings);
	return { timeZone: s?.tz ?? 'UTC' };
}

export async function punchDay(tx: Tx, employeeId: string, at: Date) {
	const { timeZone: current } = await calendar(tx, employeeId);
	const place = async (timeZone: string) => {
		const local = dateIn(at, timeZone);
		const shift = await shiftOn(tx, employeeId, local);
		return { day: shift ? shiftDayOf(at, shift, timeZone) : local, timeZone, shift };
	};
	const guess = await place(current);
	const [kept] = await tx
		.select({ timeZone: attendanceDays.timeZone })
		.from(attendanceDays)
		.where(and(eq(attendanceDays.employeeId, employeeId), eq(attendanceDays.date, guess.day)));
	return kept?.timeZone && kept.timeZone !== current ? place(kept.timeZone) : guess;
}

const dates = (from: string, to: string) => {
	const out: string[] = [];
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
};

export async function recomputeAttendance(tx: Tx, tenantId: string, from: string, to: string, employeeIds?: string[]) {
	const at = now();
	const people = (
		await tx
			.select({ id: employees.id, joinDate: employees.joinDate, exitDate: employees.exitDate, zone: employeeZone })
			.from(employees)
			.where(
				and(
					lte(employees.joinDate, to),
					or(sql`${employees.exitDate} is null`, gte(employees.exitDate, from)),
					employeeIds ? inArray(employees.id, employeeIds) : undefined
				)
			)
	)
		.map((p) => ({ ...p, last: [to, dateIn(at, p.zone)].sort()[0] }))
		.filter((p) => from <= p.last);
	if (!people.length) return;
	const last = people.map((p) => p.last).sort()[people.length - 1];
	const ids = people.map((p) => p.id);
	const kept = new Map(
		(
			await tx
				.select({ employeeId: attendanceDays.employeeId, date: attendanceDays.date, zone: attendanceDays.timeZone })
				.from(attendanceDays)
				.where(
					and(
						inArray(attendanceDays.employeeId, ids),
						gte(attendanceDays.date, from),
						lte(attendanceDays.date, addDays(last, 1))
					)
				)
		).map((d) => [`${d.employeeId}:${d.date}`, d.zone])
	);
	const rule = await dayRules(tx, ids, from, addDays(last, 1));
	const off = new Set(
		(
			await tx
				.select({ date: holidays.date })
				.from(holidays)
				.where(and(gte(holidays.date, from), lte(holidays.date, last)))
		).map((h) => h.date)
	);
	const leave = new Map(
		(
			await tx
				.select({
					employeeId: leaveRequestDays.employeeId,
					date: leaveRequestDays.date,
					session: leaveRequestDays.session
				})
				.from(leaveRequestDays)
				.where(
					and(
						inArray(leaveRequestDays.employeeId, ids),
						eq(leaveRequestDays.status, 'approved'),
						gte(leaveRequestDays.date, from),
						lte(leaveRequestDays.date, last)
					)
				)
		).map((l) => [`${l.employeeId}:${l.date}`, l.session as 'full' | 'am' | 'pm'])
	);
	const wfh = new Set(
		(
			await tx
				.select({ employeeId: attendanceRequests.employeeId, date: attendanceRequests.date })
				.from(attendanceRequests)
				.where(
					and(
						inArray(attendanceRequests.employeeId, ids),
						eq(attendanceRequests.kind, 'wfh'),
						eq(attendanceRequests.status, 'approved'),
						gte(attendanceRequests.date, from),
						lte(attendanceRequests.date, last)
					)
				)
		).map((w) => `${w.employeeId}:${w.date}`)
	);
	const punches = await tx
		.select({ employeeId: attendancePunches.employeeId, at: attendancePunches.at, kind: attendancePunches.kind })
		.from(attendancePunches)
		.where(
			and(
				inArray(attendancePunches.employeeId, ids),
				gte(attendancePunches.at, new Date(`${addDays(from, -2)}T00:00:00Z`)),
				lt(attendancePunches.at, new Date(`${addDays(last, 3)}T00:00:00Z`))
			)
		);
	const punchesOf = Map.groupBy(punches, (p) => p.employeeId);
	const upserts: DayRow[] = [];
	const cleared: { employeeId: string; date: string }[] = [];
	for (const p of people) {
		const own = punchesOf.get(p.id) ?? [];
		const shiftFor = (date: string): Shift | undefined => rule(p.id, date).shift;
		const zoneFor = (date: string) => kept.get(`${p.id}:${date}`) ?? p.zone;
		for (const date of dates(from, p.last)) {
			const shift = shiftFor(date);
			const timeZone = zoneFor(date);
			const next = addDays(date, 1);
			const nextShift = shiftFor(next);
			const until =
				nextShift && zoneFor(next) !== timeZone
					? new Date(zonedInstant(`${next}T00:00`, zoneFor(next)).getTime() + shiftWindow(nextShift).from * 60_000)
					: undefined;
			const employed = date >= p.joinDate && (!p.exitDate || date <= p.exitDate);
			const today = rule(p.id, date);
			const leaveSession = leave.get(`${p.id}:${date}`) ?? null;
			const day: DayResult | null =
				employed && shift
					? computeDay({
							date,
							shift,
							timeZone,
							punches: own,
							until,
							weekend: today.rest && !(today.rosterRest && leaveSession === 'full'),
							holiday: off.has(date),
							leave: leaveSession,
							wfh: wfh.has(`${p.id}:${date}`),
							now: at
						})
					: null;
			if (day) upserts.push({ tenantId, employeeId: p.id, date, shiftId: shift!.id, timeZone, ...day });
			else cleared.push({ employeeId: p.id, date });
		}
	}
	for (let i = 0; i < upserts.length; i += 1000)
		await tx
			.insert(attendanceDays)
			.values(upserts.slice(i, i + 1000))
			.onConflictDoUpdate({
				target: [attendanceDays.tenantId, attendanceDays.employeeId, attendanceDays.date],
				set: {
					shiftId: sql`excluded.shift_id`,
					status: sql`excluded.status`,
					firstIn: sql`excluded.first_in`,
					lastOut: sql`excluded.last_out`,
					workedMinutes: sql`excluded.worked_minutes`,
					lateMinutes: sql`excluded.late_minutes`,
					timeZone: sql`excluded.time_zone`
				}
			});
	for (let i = 0; i < cleared.length; i += 5000)
		await tx.delete(attendanceDays).where(
			sql`(${attendanceDays.employeeId}, ${attendanceDays.date}) in (${sql.join(
				cleared.slice(i, i + 5000).map((c) => sql`(${c.employeeId}::uuid, ${c.date}::date)`),
				sql`, `
			)})`
		);
}

export async function shiftOn(tx: Tx, employeeId: string, date: string) {
	return (await dayRules(tx, [employeeId], date, date))(employeeId, date).shift;
}

type PunchExtra = {
	kind?: 'break_start' | 'break_end' | null;
	ip?: string | null;
	point?: Point | null;
	siteId?: string | null;
	outsideSite?: boolean;
};

export type PunchActor = { tenantId: string; userId: string | null };
type Punchable = { id: string; joinDate: string; exitDate: string | null; status: string };
const actorOf = (m: Member): PunchActor => ({ tenantId: m.tenant.id, userId: m.user.userId });

async function savePunch(
	tx: Tx,
	actor: PunchActor,
	e: Punchable,
	at: Date,
	source: 'web' | 'manual' | 'kiosk',
	extra: PunchExtra = {}
) {
	const { day } = await punchDay(tx, e.id, at);
	if (day < e.joinDate || (e.exitDate && day > e.exitDate) || e.status === 'exited')
		throw new AppError('not_employed', 'Punches only count while employed.', 400);
	const closed = source !== 'manual' && (await payrollClosedMonths(tx, [e.id], [day.slice(0, 7)])).size > 0;
	const saved = await tx
		.insert(attendancePunches)
		.values({
			tenantId: actor.tenantId,
			employeeId: e.id,
			at,
			source,
			ip: extra.ip ?? null,
			kind: extra.kind ?? null,
			lat: extra.point?.lat ?? null,
			lng: extra.point?.lng ?? null,
			accuracyM: extra.point ? Math.round(extra.point.accuracyM) : null,
			siteId: extra.siteId ?? null,
			outsideSite: extra.outsideSite ?? false,
			needsReview: closed,
			createdByUserId: actor.userId
		})
		.onConflictDoNothing()
		.returning({ id: attendancePunches.id });
	if (!saved.length) throw new AppError('duplicate', 'That punch is already recorded.', 409);
	await recomputeAttendance(tx, actor.tenantId, addDays(day, -1), addDays(day, 1), [e.id]);
}

export type PunchInput = ReturnType<typeof punchInput>;

export async function checkedPunch(
	tx: Tx,
	actor: PunchActor,
	e: Punchable,
	source: 'web' | 'kiosk',
	kind: PunchInput['kind'],
	place: (at: Date) => Promise<Omit<PunchExtra, 'kind'>>
) {
	const at = now();
	const [recent] = await tx
		.select({ id: attendancePunches.id })
		.from(attendancePunches)
		.where(and(eq(attendancePunches.employeeId, e.id), gte(attendancePunches.at, new Date(at.getTime() - 60_000))))
		.limit(1);
	if (recent) throw new AppError('too_soon', 'You punched less than a minute ago.', 429);
	const today = (await dayPunches(tx, e.id, at)).punches;
	if (kind === 'break_start' && (!clockedIn(today) || onBreak(today)))
		throw new AppError('no_break', 'Punch in before starting a break.', 409);
	if (kind === 'break_end' && !onBreak(today)) throw new AppError('no_break', 'There is no break to end.', 409);
	const extra = await place(at);
	await savePunch(tx, actor, e, at, source, { ...extra, kind });
	return { at, outsideSite: extra.outsideSite ?? false };
}

const punchSchema = z
	.object({
		kind: z.enum(['', 'break_start', 'break_end']).catch(''),
		lat: z.coerce.number().min(-90).max(90).optional().catch(undefined),
		lng: z.coerce.number().min(-180).max(180).optional().catch(undefined),
		accuracy: z.coerce.number().min(0).max(100_000).optional().catch(undefined)
	})
	.transform((v) => ({
		kind: v.kind || null,
		point:
			v.lat !== undefined && v.lng !== undefined && v.accuracy !== undefined
				? { lat: v.lat, lng: v.lng, accuracyM: v.accuracy }
				: null
	}));

const blank = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v);

export function punchInput(raw: Record<string, string>) {
	return punchSchema.parse({
		kind: raw.kind ?? '',
		lat: blank(raw.lat),
		lng: blank(raw.lng),
		accuracy: blank(raw.accuracy)
	});
}

type Marked = { kind: string | null };
export const onBreak = (punches: Marked[]) => punches.at(-1)?.kind === 'break_start';
export const clockedIn = (punches: Marked[]) =>
	punches.filter((p) => p.kind !== 'break_start' && p.kind !== 'break_end').length % 2 === 1;

export async function punch(m: Member, ip: string | null, raw: Record<string, string> = {}) {
	if (!m.access.employeeId) throw new AppError('no_employee', 'Your account is not linked to an employee record.', 403);
	const employeeId = m.access.employeeId;
	const input = punchInput(raw);
	return withTenant(userCtx(m), async (tx) => {
		const e = await lockEmployee(tx, m.access, employeeId);
		if (!inScope(await resolveScope(tx, m.access, 'attendance.punch'), e.id))
			throw new AppError('forbidden', 'You cannot record attendance.', 403);
		const done = await checkedPunch(tx, actorOf(m), e, 'web', input.kind, async () => {
			const address = clientIp(ip) ?? ip?.slice(0, 64) ?? null;
			const rule = await punchRule(tx);
			const siteId = rule === 'off' ? null : await matchSite(tx, e.id, address, input.point);
			if (rule === 'block' && !siteId)
				throw new AppError(
					'outside_site',
					'You are not at a work site. Punch from the office network or turn on location and try again.',
					403
				);
			return {
				ip: address,
				point: rule === 'off' ? null : input.point,
				siteId,
				outsideSite: rule === 'flag' && !siteId
			};
		});
		return { outsideSite: done.outsideSite };
	});
}

const manualSchema = z.object({
	at: z.iso.datetime({ local: true, error: 'Enter the date and time of the punch.' })
});

export async function addManualPunch(m: Member, employeeId: string, raw: Record<string, string>) {
	const input = manualSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const e = await lockEmployee(tx, m.access, employeeId);
		if (!inScope(await resolveScope(tx, m.access, 'attendance.manage'), e.id))
			throw new AppError('forbidden', 'You cannot record attendance for this person.', 403);
		if (m.access.employeeId === e.id)
			throw new AppError('self_change', 'Someone else has to add punches for you.', 403);
		const when = zonedInstant(input.at, (await calendar(tx, e.id)).timeZone);
		if (when > now()) throw new AppError('future', 'A punch cannot be in the future.', 400);
		await savePunch(tx, actorOf(m), e, when, 'manual');
	});
}

export const MAX_PUNCH_ROWS = 20000;
const LOCAL_STAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/;
const OFFSET_STAMP = z.iso.datetime({ offset: true });

function readStamp(raw: string, timeZone: string) {
	const local = LOCAL_STAMP.exec(raw);
	if (local) {
		const at = zonedInstant(`${local[1]}T${local[2]}`, timeZone);
		return new Date(at.getTime() + Number(local[3] ?? 0) * 1000);
	}
	return OFFSET_STAMP.safeParse(raw).success ? new Date(raw) : null;
}

export async function importPunches(m: Member, table: string[][]) {
	const body = csvRecords(table, ['employee_code', 'timestamp'], MAX_PUNCH_ROWS);
	return withTenant(userCtx(m), async (tx) => {
		const scope = await resolveScope(tx, m.access, 'attendance.manage');
		const selfAllowed = await singleAdmin(tx);
		const people = new Map(
			(
				await tx
					.select({
						id: employees.id,
						code: employees.code,
						joinDate: employees.joinDate,
						exitDate: employees.exitDate,
						zone: employeeZone
					})
					.from(employees)
					.where(scopeWhere(scope, employees.id))
			).map((e) => [e.code.toLowerCase(), e])
		);
		const at = now();
		const errors: ImportRowError[] = [];
		const list: { employeeId: string; at: Date; day: string }[] = [];
		for (const { line, v } of body) {
			const e = people.get(v.employee_code.toLowerCase());
			const when = e && readStamp(v.timestamp, e.zone);
			const day = when && dateIn(when, e.zone);
			const problem = !e
				? 'Unknown employee code.'
				: e.id === m.access.employeeId && !selfAllowed
					? 'Someone else has to import your own punches.'
					: !when || !day
						? 'Use a timestamp like 2026-03-10 09:05 or 2026-03-10T09:05:00+06:00.'
						: when > at
							? 'A punch cannot be in the future.'
							: day < e.joinDate || (e.exitDate && day > addDays(e.exitDate, 1))
								? "The punch falls outside this person's employment."
								: null;
			if (problem) errors.push({ line, message: problem });
			else list.push({ employeeId: e!.id, at: when!, day: day! });
		}
		if (errors.length) throw new ImportFailed(errors);
		let added = 0;
		for (let i = 0; i < list.length; i += 1000)
			added += (
				await tx
					.insert(attendancePunches)
					.values(
						list.slice(i, i + 1000).map((r) => ({
							tenantId: m.tenant.id,
							employeeId: r.employeeId,
							at: r.at,
							source: 'device',
							createdByUserId: m.user.userId
						}))
					)
					.onConflictDoNothing()
					.returning({ id: attendancePunches.id })
			).length;
		const days = list.map((r) => r.day).sort();
		await recomputeAttendance(tx, m.tenant.id, addDays(days[0], -1), addDays(days[days.length - 1], 1), [
			...new Set(list.map((r) => r.employeeId))
		]);
		return { added, skipped: body.length - added };
	});
}

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export async function attendanceMonth(tx: Tx, access: Access, employeeId: string, month?: string) {
	if (!inScope(await resolveScope(tx, access, 'attendance.read'), employeeId)) return null;
	const { timeZone } = await calendar(tx, employeeId);
	const today = dateIn(now(), timeZone);
	const m = monthSchema.safeParse(month).success ? month! : today.slice(0, 7);
	const from = `${m}-01`;
	const [y, mo] = m.split('-').map(Number);
	const to = addDays(mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`, -1);
	const days = await tx
		.select({
			date: attendanceDays.date,
			status: attendanceDays.status,
			firstIn: attendanceDays.firstIn,
			lastOut: attendanceDays.lastOut,
			workedMinutes: attendanceDays.workedMinutes,
			lateMinutes: attendanceDays.lateMinutes,
			timeZone: attendanceDays.timeZone
		})
		.from(attendanceDays)
		.where(and(eq(attendanceDays.employeeId, employeeId), gte(attendanceDays.date, from), lte(attendanceDays.date, to)))
		.orderBy(asc(attendanceDays.date));
	return { month: m, timeZone, today, days };
}

export async function dayPunches(tx: Tx, employeeId: string, at: Date) {
	const { day, timeZone, shift } = await punchDay(tx, employeeId, at);
	const rows = await tx
		.select({
			at: attendancePunches.at,
			source: attendancePunches.source,
			kind: attendancePunches.kind,
			outsideSite: attendancePunches.outsideSite
		})
		.from(attendancePunches)
		.where(
			and(
				eq(attendancePunches.employeeId, employeeId),
				sql`${attendancePunches.at} >= (${addDays(day, -1)}::date)::timestamp at time zone ${timeZone}`,
				sql`${attendancePunches.at} < (${addDays(day, 2)}::date)::timestamp at time zone ${timeZone}`
			)
		)
		.orderBy(asc(attendancePunches.at));
	return {
		day,
		timeZone,
		shift,
		punches: shift ? rows.filter((r) => shiftDayOf(r.at, shift, timeZone) === day) : rows
	};
}

export async function todayPunches(tx: Tx, access: Access) {
	if (!access.employeeId) return null;
	const { day, timeZone, shift, punches } = await dayPunches(tx, access.employeeId, now());
	const [status] = await tx
		.select({ status: attendanceDays.status, workedMinutes: attendanceDays.workedMinutes })
		.from(attendanceDays)
		.where(and(eq(attendanceDays.employeeId, access.employeeId), eq(attendanceDays.date, day)));
	return {
		day,
		timeZone,
		shift,
		punches,
		status: status ?? null,
		onBreak: onBreak(punches),
		clockedIn: clockedIn(punches)
	};
}

export async function teamDay(tx: Tx, access: Access, date: string) {
	const scope = await resolveScope(tx, access, 'attendance.read');
	return tx
		.select({
			id: employees.id,
			code: employees.code,
			fullName: employees.fullName,
			status: attendanceDays.status,
			firstIn: attendanceDays.firstIn,
			lastOut: attendanceDays.lastOut,
			workedMinutes: attendanceDays.workedMinutes,
			lateMinutes: attendanceDays.lateMinutes,
			timeZone: attendanceDays.timeZone,
			outsideSite: sql<boolean>`coalesce((select bool_or(p.outside_site) from attendance_punches p where p.employee_id = employees.id and p.at between attendance_days.first_in and coalesce(attendance_days.last_out, attendance_days.first_in)), false)`
		})
		.from(employees)
		.leftJoin(attendanceDays, and(eq(attendanceDays.employeeId, employees.id), eq(attendanceDays.date, date)))
		.where(
			and(
				scopeWhere(scope, employees.id),
				lte(employees.joinDate, date),
				or(sql`${employees.exitDate} is null`, gte(employees.exitDate, date)),
				ne(employees.status, 'exited')
			)
		)
		.orderBy(asc(employees.fullName))
		.limit(500);
}

export async function recomputeTenantAttendance(tenantId: string) {
	await withTenant(systemCtx(tenantId), async (tx) => {
		const zones = await tx.execute<{ zone: string }>(
			sql`select timezone as zone from tenant_settings union select timezone from branches where timezone is not null`
		);
		const at = now();
		const days = zones.map((z) => dateIn(at, z.zone)).sort();
		if (days.length) await recomputeAttendance(tx, tenantId, addDays(days[0], -1), days[days.length - 1]);
	});
}

export async function runAttendance() {
	const list = await authPool().db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
	for (const t of list)
		await recomputeTenantAttendance(t.id).catch((err) =>
			log.error({ tenantId: t.id, err: (err as Error).message }, 'attendance recompute failed')
		);
}
