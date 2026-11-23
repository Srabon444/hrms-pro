import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computeDay, shiftDayOf, zonedInstant, type DayResult } from './attendance-day';
import { now } from './clock';
import { addDays, dateIn } from './dates';
import { authPool } from './db';
import {
	attendanceDays,
	attendancePunches,
	employees,
	holidays,
	leaveRequestDays,
	shiftAssignments,
	shifts,
	tenants,
	tenantSettings
} from './db/schema';
import { AppError } from './errors';
import { lockEmployee } from './employees';
import { log } from './log';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { systemCtx, withTenant, type Tx } from './tenancy';
import type { Shift } from './shifts';

type Member = ReturnType<typeof requireMember>;
type DayRow = typeof attendanceDays.$inferInsert;

async function calendar(tx: Tx) {
	const [s] = await tx
		.select({ tz: tenantSettings.timezone, weekendDays: tenantSettings.weekendDays })
		.from(tenantSettings);
	return { timeZone: s?.tz ?? 'UTC', weekendDays: s?.weekendDays ?? [5, 6] };
}

const dates = (from: string, to: string) => {
	const out: string[] = [];
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
};

export async function recomputeAttendance(tx: Tx, tenantId: string, from: string, to: string, employeeIds?: string[]) {
	const { timeZone, weekendDays } = await calendar(tx);
	const at = now();
	const last = [to, dateIn(at, timeZone)].sort()[0];
	if (from > last) return;
	const people = await tx
		.select({ id: employees.id, joinDate: employees.joinDate, exitDate: employees.exitDate })
		.from(employees)
		.where(
			and(
				lte(employees.joinDate, last),
				or(sql`${employees.exitDate} is null`, gte(employees.exitDate, from)),
				employeeIds ? inArray(employees.id, employeeIds) : undefined
			)
		);
	if (!people.length) return;
	const ids = people.map((p) => p.id);
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
	const punches = await tx
		.select({ employeeId: attendancePunches.employeeId, at: attendancePunches.at })
		.from(attendancePunches)
		.where(
			and(
				inArray(attendancePunches.employeeId, ids),
				sql`${attendancePunches.at} >= (${addDays(from, -1)}::date)::timestamp at time zone ${timeZone}`,
				sql`${attendancePunches.at} < (${addDays(last, 2)}::date)::timestamp at time zone ${timeZone}`
			)
		);
	const punchesOf = Map.groupBy(punches, (p) => p.employeeId);
	const upserts: DayRow[] = [];
	const cleared: { employeeId: string; date: string }[] = [];
	for (const p of people) {
		const mine = assignments.filter((a) => a.employeeId === p.id);
		const own = (punchesOf.get(p.id) ?? []).map((x) => x.at);
		for (const date of dates(from, last)) {
			const a = mine.find((x) => x.effectiveFrom <= date);
			const shift: Shift | undefined = a ? allShifts.get(a.shiftId) : fallback;
			const employed = date >= p.joinDate && (!p.exitDate || date <= p.exitDate);
			const day: DayResult | null =
				employed && shift
					? computeDay({
							date,
							shift,
							timeZone,
							punches: own,
							weekend: weekendDays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()),
							holiday: off.has(date),
							leave: leave.get(`${p.id}:${date}`) ?? null,
							wfh: false,
							now: at
						})
					: null;
			if (day) upserts.push({ tenantId, employeeId: p.id, date, shiftId: shift!.id, ...day });
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
					lateMinutes: sql`excluded.late_minutes`
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

async function shiftOn(tx: Tx, employeeId: string, date: string) {
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
	const { timeZone } = await calendar(tx);
	const local = dateIn(at, timeZone);
	const shift = await shiftOn(tx, e.id, local);
	const day = shift ? shiftDayOf(at, shift, timeZone) : local;
	if (day < e.joinDate || (e.exitDate && day > e.exitDate) || e.status === 'exited')
		throw new AppError('not_employed', 'Punches only count while employed.', 400);
	const saved = await tx
		.insert(attendancePunches)
		.values({ tenantId: m.tenant.id, employeeId: e.id, at, source, ip, createdByUserId: m.user.userId })
		.onConflictDoNothing()
		.returning({ id: attendancePunches.id });
	if (!saved.length) throw new AppError('duplicate', 'That punch is already recorded.', 409);
	await recomputeAttendance(tx, m.tenant.id, addDays(day, -1), day, [e.id]);
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
		const when = zonedInstant(input.at, (await calendar(tx)).timeZone);
		if (when > now()) throw new AppError('future', 'A punch cannot be in the future.', 400);
		await savePunch(tx, m, e, when, 'manual', null);
	});
}

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export async function attendanceMonth(tx: Tx, access: Access, employeeId: string, month?: string) {
	if (!inScope(await resolveScope(tx, access, 'attendance.read'), employeeId)) return null;
	const { timeZone } = await calendar(tx);
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
			lateMinutes: attendanceDays.lateMinutes
		})
		.from(attendanceDays)
		.where(and(eq(attendanceDays.employeeId, employeeId), gte(attendanceDays.date, from), lte(attendanceDays.date, to)))
		.orderBy(asc(attendanceDays.date));
	return { month: m, timeZone, today, days };
}

export async function todayPunches(tx: Tx, access: Access) {
	if (!access.employeeId) return null;
	const { timeZone } = await calendar(tx);
	const at = now();
	const shift = await shiftOn(tx, access.employeeId, dateIn(at, timeZone));
	const day = shift ? shiftDayOf(at, shift, timeZone) : dateIn(at, timeZone);
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
			lateMinutes: attendanceDays.lateMinutes
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
		const today = dateIn(now(), (await calendar(tx)).timeZone);
		await recomputeAttendance(tx, tenantId, addDays(today, -1), today);
	});
}

export async function runAttendance() {
	const list = await authPool().db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
	for (const t of list)
		await recomputeTenantAttendance(t.id).catch((err) =>
			log.error({ tenantId: t.id, err: (err as Error).message }, 'attendance recompute failed')
		);
}
