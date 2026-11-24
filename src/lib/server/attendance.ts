import { and, asc, desc, eq, gte, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
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
	shiftAssignments,
	shifts,
	tenants,
	tenantSettings
} from './db/schema';
import { AppError } from './errors';
import { csvRecords, ImportFailed, type ImportRowError } from './csv';
import { lockEmployee } from './employees';
import { log } from './log';
import { singleAdmin } from './approval-chain';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { systemCtx, withTenant, type Tx } from './tenancy';
import type { Shift } from './shifts';

type Member = ReturnType<typeof requireMember>;
type DayRow = typeof attendanceDays.$inferInsert;

export const employeeZone = sql<string>`coalesce((select b.timezone from branches b where b.id = employees.branch_id), (select s.timezone from tenant_settings s), 'UTC')`;

export async function calendar(tx: Tx, employeeId?: string | null) {
	const [s] = await tx
		.select({
			tz: employeeId
				? sql<string>`coalesce((select b.timezone from employees e join branches b on b.id = e.branch_id where e.id = ${employeeId}), tenant_settings.timezone)`
				: tenantSettings.timezone,
			weekendDays: tenantSettings.weekendDays
		})
		.from(tenantSettings);
	return { timeZone: s?.tz ?? 'UTC', weekendDays: s?.weekendDays ?? [5, 6] };
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
	const { weekendDays } = await calendar(tx);
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
	const allShifts = new Map((await tx.select().from(shifts)).map((s) => [s.id, s]));
	const fallback = [...allShifts.values()].find((s) => s.isDefault);
	const assignments = await tx
		.select()
		.from(shiftAssignments)
		.where(and(inArray(shiftAssignments.employeeId, ids), lte(shiftAssignments.effectiveFrom, last)))
		.orderBy(desc(shiftAssignments.effectiveFrom));
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
		.select({ employeeId: attendancePunches.employeeId, at: attendancePunches.at })
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
		const mine = assignments.filter((a) => a.employeeId === p.id);
		const own = (punchesOf.get(p.id) ?? []).map((x) => x.at);
		const shiftFor = (date: string): Shift | undefined => {
			const a = mine.find((x) => x.effectiveFrom <= date);
			return a ? allShifts.get(a.shiftId) : fallback;
		};
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
			const day: DayResult | null =
				employed && shift
					? computeDay({
							date,
							shift,
							timeZone,
							punches: own,
							until,
							weekend: weekendDays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()),
							holiday: off.has(date),
							leave: leave.get(`${p.id}:${date}`) ?? null,
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
	const [a] = await tx
		.select({ shift: shifts })
		.from(shiftAssignments)
		.innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
		.where(and(eq(shiftAssignments.employeeId, employeeId), lte(shiftAssignments.effectiveFrom, date)))
		.orderBy(desc(shiftAssignments.effectiveFrom))
		.limit(1);
	if (a) return a.shift;
	const [d] = await tx.select().from(shifts).where(eq(shifts.isDefault, true));
	return d;
}

async function savePunch(
	tx: Tx,
	m: Member,
	e: { id: string; joinDate: string; exitDate: string | null; status: string },
	at: Date,
	source: 'web' | 'manual',
	ip: string | null
) {
	const { day } = await punchDay(tx, e.id, at);
	if (day < e.joinDate || (e.exitDate && day > e.exitDate) || e.status === 'exited')
		throw new AppError('not_employed', 'Punches only count while employed.', 400);
	const saved = await tx
		.insert(attendancePunches)
		.values({ tenantId: m.tenant.id, employeeId: e.id, at, source, ip, createdByUserId: m.user.userId })
		.onConflictDoNothing()
		.returning({ id: attendancePunches.id });
	if (!saved.length) throw new AppError('duplicate', 'That punch is already recorded.', 409);
	await recomputeAttendance(tx, m.tenant.id, addDays(day, -1), addDays(day, 1), [e.id]);
}

export async function punch(m: Member, ip: string | null) {
	if (!m.access.employeeId) throw new AppError('no_employee', 'Your account is not linked to an employee record.', 403);
	const employeeId = m.access.employeeId;
	await withTenant(userCtx(m), async (tx) => {
		const e = await lockEmployee(tx, m.access, employeeId);
		if (!inScope(await resolveScope(tx, m.access, 'attendance.punch'), e.id))
			throw new AppError('forbidden', 'You cannot record attendance.', 403);
		const at = now();
		const [recent] = await tx
			.select({ id: attendancePunches.id })
			.from(attendancePunches)
			.where(and(eq(attendancePunches.employeeId, e.id), gte(attendancePunches.at, new Date(at.getTime() - 60_000))))
			.limit(1);
		if (recent) throw new AppError('too_soon', 'You punched less than a minute ago.', 429);
		await savePunch(tx, m, e, at, 'web', ip?.slice(0, 64) ?? null);
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
		await savePunch(tx, m, e, when, 'manual', null);
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
		if (errors.length) throw new ImportFailed(errors.slice(0, 50));
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

export async function todayPunches(tx: Tx, access: Access) {
	if (!access.employeeId) return null;
	const { day, timeZone, shift } = await punchDay(tx, access.employeeId, now());
	const rows = await tx
		.select({ at: attendancePunches.at, source: attendancePunches.source })
		.from(attendancePunches)
		.where(
			and(
				eq(attendancePunches.employeeId, access.employeeId),
				sql`${attendancePunches.at} >= (${addDays(day, -1)}::date)::timestamp at time zone ${timeZone}`,
				sql`${attendancePunches.at} < (${addDays(day, 2)}::date)::timestamp at time zone ${timeZone}`
			)
		)
		.orderBy(asc(attendancePunches.at));
	const mine = shift ? rows.filter((r) => shiftDayOf(r.at, shift, timeZone) === day) : rows;
	const [status] = await tx
		.select({ status: attendanceDays.status, workedMinutes: attendanceDays.workedMinutes })
		.from(attendanceDays)
		.where(and(eq(attendanceDays.employeeId, access.employeeId), eq(attendanceDays.date, day)));
	return { day, timeZone, shift, punches: mine, status: status ?? null };
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
			timeZone: attendanceDays.timeZone
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
