import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { activeMemberships, approvers, deciderWhere, rightsOver, singleAdmin } from './approval-chain';
import type { ApprovalItem } from './approvals';
import type { AttachmentRules } from './attachments';
import { calendar, employeeZone, punchDay, recomputeAttendance } from './attendance';
import { compDays, creditCompOff } from './comp-off';
import { zonedInstant } from './attendance-day';
import { now } from './clock';
import { addDays, dateIn, zoneFormat } from './dates';
import {
	attendanceDays,
	attendancePunches,
	attendanceRequests,
	departments,
	employees,
	holidays,
	shifts,
	tenantSettings
} from './db/schema';
import { AppError } from './errors';
import { lockEmployee } from './employees';
import { notify, sendAll } from './notifications';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Request = typeof attendanceRequests.$inferSelect;

export const KIND_LABELS: Record<string, string> = {
	regularization: 'Missed punch',
	wfh: 'Work from home',
	overtime: 'Overtime'
};
const ACTIVE = ['pending', 'approved'];
const notFound = () => new AppError('not_found', 'That attendance request does not exist.', 404);
const stamp = (at: Date, timeZone: string) =>
	zoneFormat(timeZone, { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }, 'sv-SE').format(at);
const roundDown = (minutes: number) => Math.floor(minutes / 15) * 15;
const reason = z.string().trim().min(1, 'Say why.').max(500, 'Keep the reason under 500 characters.');
const minutes = (message: string) => z.coerce.number(message).int(message).min(15, message).max(1440, message);

const requestSchema = z.discriminatedUnion(
	'kind',
	[
		z.object({
			kind: z.literal('regularization'),
			at: z.iso.datetime({ local: true, error: 'Enter the date and time you were in or out.' }),
			reason
		}),
		z.object({ kind: z.literal('wfh'), date: z.iso.date('Enter the day.'), reason }),
		z.object({
			kind: z.literal('overtime'),
			date: z.iso.date('Enter the day.'),
			minutes: minutes('Enter overtime as 15 to 1440 minutes.'),
			reason
		})
	],
	{ error: 'Choose what you are asking for.' }
);

const describe = (r: Pick<Request, 'kind' | 'date' | 'punchAt' | 'minutes'>, timeZone: string) =>
	r.kind === 'regularization'
		? `${KIND_LABELS.regularization} at ${stamp(r.punchAt!, timeZone)}`
		: r.kind === 'overtime'
			? `${KIND_LABELS.overtime} on ${r.date}, ${r.minutes} min`
			: `${KIND_LABELS.wfh} on ${r.date}`;

export async function requestAttendance(m: Member, raw: Record<string, string>) {
	const input = requestSchema.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		if (!m.access.employeeId)
			throw new AppError('no_employee', 'Your account is not linked to an employee record.', 403);
		const e = await lockEmployee(tx, m.access, m.access.employeeId);
		if (!inScope(await resolveScope(tx, m.access, 'attendance.punch'), e.id))
			throw new AppError('forbidden', 'You cannot ask for attendance changes.', 403);
		const { timeZone, weekendDays } = await calendar(tx, e.id);
		const at = now();
		const today = dateIn(at, timeZone);
		let date: string;
		let punchAt: Date | null = null;
		if (input.kind === 'regularization') {
			punchAt = zonedInstant(input.at, timeZone);
			if (punchAt > at) throw new AppError('future', 'A missed punch cannot be in the future.', 400);
			date = (await punchDay(tx, e.id, punchAt)).day;
			const [taken] = await tx
				.select({ id: attendancePunches.id })
				.from(attendancePunches)
				.where(and(eq(attendancePunches.employeeId, e.id), eq(attendancePunches.at, punchAt)));
			if (taken) throw new AppError('duplicate', 'That punch is already recorded.', 409);
		} else {
			date = input.date;
			if (input.kind === 'overtime' && date > today)
				throw new AppError('future', 'Ask for overtime once the day has started.', 400);
			if (input.kind === 'wfh') {
				const [h] = await tx.select({ id: holidays.id }).from(holidays).where(eq(holidays.date, date));
				if (h || weekendDays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()))
					throw new AppError('not_working_day', 'That day is a weekend or holiday.', 400);
			}
		}
		if (date < e.joinDate || (e.exitDate && date > e.exitDate) || e.status === 'exited')
			throw new AppError('not_employed', 'Pick a day between your join date and last day.', 400);
		const clash = await tx
			.select({ id: attendanceRequests.id })
			.from(attendanceRequests)
			.where(
				and(
					eq(attendanceRequests.employeeId, e.id),
					eq(attendanceRequests.kind, input.kind),
					inArray(attendanceRequests.status, ACTIVE),
					punchAt ? eq(attendanceRequests.punchAt, punchAt) : eq(attendanceRequests.date, date)
				)
			);
		if (clash.length) throw new AppError('overlap', 'You already asked for this.', 409);
		const row = {
			tenantId: m.tenant.id,
			employeeId: e.id,
			kind: input.kind,
			date,
			punchAt,
			minutes: input.kind === 'overtime' ? input.minutes : null,
			reason: input.reason,
			requestedByUserId: m.user.userId
		};
		const [req] = await tx.insert(attendanceRequests).values(row).returning({ id: attendanceRequests.id });
		return notify(
			tx,
			m.tenant.id,
			await approvers(tx, e, 'attendance'),
			{
				category: 'approvals',
				title: `${e.fullName} asked for ${KIND_LABELS[input.kind].toLowerCase()}`,
				body: describe(row, timeZone),
				link: `approvals/attendance/${req.id}`
			},
			m.tenant.slug
		);
	});
	await sendAll(mails);
}

async function load(tx: Tx, access: Access, requestId: string, lock: boolean) {
	const id = z.uuid().safeParse(requestId);
	if (!id.success) return null;
	const q = tx.select().from(attendanceRequests).where(eq(attendanceRequests.id, id.data));
	const [r] = lock ? await q.for('update') : await q;
	if (!r) return null;
	const [e] = await tx.select().from(employees).where(eq(employees.id, r.employeeId));
	const rights = await rightsOver(tx, access, e, 'attendance');
	return rights.canView ? { r, e, rights } : null;
}

const cancellable = (r: Request, today: string) =>
	r.status === 'pending' || (r.status === 'approved' && r.date > today);

async function dayOf(tx: Tx, employeeId: string, date: string) {
	const [d] = await tx
		.select({
			status: attendanceDays.status,
			firstIn: attendanceDays.firstIn,
			lastOut: attendanceDays.lastOut,
			workedMinutes: attendanceDays.workedMinutes,
			halfDayMinutes: shifts.halfDayMinutes,
			fullDayMinutes: shifts.fullDayMinutes
		})
		.from(attendanceDays)
		.leftJoin(shifts, eq(shifts.id, attendanceDays.shiftId))
		.where(and(eq(attendanceDays.employeeId, employeeId), eq(attendanceDays.date, date)));
	return d ?? null;
}

type Day = Awaited<ReturnType<typeof dayOf>>;
const offDay = (d: Day) => !!d && ['weekend', 'holiday'].includes(d.status);
const extraMinutes = (d: Day) => (!d ? 0 : offDay(d) ? d.workedMinutes : d.workedMinutes - (d.fullDayMinutes ?? 0));

export async function getAttendanceRequest(tx: Tx, access: Access, requestId: string) {
	const found = await load(tx, access, requestId, false);
	if (!found) return null;
	const { r, e, rights } = found;
	const { timeZone } = await calendar(tx, e.id);
	const day = await dayOf(tx, e.id, r.date);
	return {
		id: r.id,
		kind: r.kind,
		label: KIND_LABELS[r.kind],
		status: r.status,
		employee: { id: e.id, code: e.code, fullName: e.fullName },
		date: r.date,
		punchAt: r.punchAt ? stamp(r.punchAt, timeZone) : null,
		minutes: r.minutes,
		approvedMinutes: r.approvedMinutes,
		reason: r.reason,
		decisionNote: r.decisionNote,
		day: day && {
			status: day.status,
			firstIn: day.firstIn && stamp(day.firstIn, timeZone),
			lastOut: day.lastOut && stamp(day.lastOut, timeZone),
			workedMinutes: day.workedMinutes,
			extraMinutes: Math.max(0, extraMinutes(day))
		},
		compOff: r.kind === 'overtime' && offDay(day),
		canDecide: rights.canDecide && r.status === 'pending',
		canCancel: rights.canCancel && cancellable(r, dateIn(now(), timeZone))
	};
}

const decisionSchema = z.object({
	decision: z.enum(['approve', 'reject']),
	note: z
		.string()
		.trim()
		.max(500, 'Keep the note under 500 characters.')
		.default('')
		.transform((v) => v || null),
	minutes: z.union([z.literal('').transform(() => null), minutes('Approve 15 to 1440 minutes.')]).default(null)
});

async function overtimeMinutes(tx: Tx, r: Request, asked: number | null) {
	const day = await dayOf(tx, r.employeeId, r.date);
	const [s] = await tx.select({ cap: tenantSettings.overtimeDailyCapMinutes }).from(tenantSettings);
	const limits = [r.minutes!, asked ?? r.minutes!, extraMinutes(day), offDay(day) ? 1440 : (s?.cap ?? 120)];
	const approved = roundDown(Math.min(...limits));
	if (approved < 15)
		throw new AppError('no_overtime', 'Attendance shows less than 15 minutes of overtime that day.', 409);
	const comp =
		offDay(day) && day!.fullDayMinutes
			? compDays(approved, { halfDayMinutes: day!.halfDayMinutes!, fullDayMinutes: day!.fullDayMinutes })
			: 0;
	return { approved, comp };
}

export async function decideAttendance(m: Member, requestId: string, raw: Record<string, string>) {
	const input = decisionSchema.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		const found = await load(tx, m.access, requestId, true);
		if (!found) throw notFound();
		const { r, rights } = found;
		if (r.status !== 'pending') throw new AppError('already_decided', 'This request was already handled.', 409);
		if (!rights.canDecide)
			throw rights.own
				? new AppError('self_approval', 'Someone else has to decide on your own request.', 403)
				: new AppError('forbidden', 'You cannot decide on this request.', 403);
		const approve = input.decision === 'approve';
		const overtime = approve && r.kind === 'overtime' ? await overtimeMinutes(tx, r, input.minutes) : null;
		const approvedMinutes = overtime?.approved ?? null;
		const credited = overtime ? await creditCompOff(tx, m.tenant.id, r, overtime.comp, m.user.userId) : 0;
		await tx
			.update(attendanceRequests)
			.set({
				status: approve ? 'approved' : 'rejected',
				approvedMinutes,
				decidedByUserId: m.user.userId,
				decidedAt: now(),
				decisionNote: input.note
			})
			.where(eq(attendanceRequests.id, r.id));
		if (approve && r.kind === 'regularization') {
			await tx
				.insert(attendancePunches)
				.values({
					tenantId: m.tenant.id,
					employeeId: r.employeeId,
					at: r.punchAt!,
					source: 'regularization',
					createdByUserId: m.user.userId
				})
				.onConflictDoNothing();
			await recomputeAttendance(tx, m.tenant.id, addDays(r.date, -1), r.date, [r.employeeId]);
		}
		if (approve && r.kind === 'wfh') await recomputeAttendance(tx, m.tenant.id, r.date, r.date, [r.employeeId]);
		const { timeZone } = await calendar(tx, r.employeeId);
		return notify(
			tx,
			m.tenant.id,
			await activeMemberships(tx, r.employeeId),
			{
				category: 'approvals',
				title: `Your ${describe(r, timeZone).toLowerCase()} was ${approve ? 'approved' : 'declined'}`,
				body: [
					approvedMinutes !== null ? `${approvedMinutes} min approved.` : '',
					credited ? `${credited} day${credited === 1 ? '' : 's'} of compensatory leave added.` : '',
					input.note ?? ''
				]
					.filter(Boolean)
					.join(' '),
				link: 'attendance'
			},
			m.tenant.slug
		);
	});
	await sendAll(mails);
}

export async function cancelAttendanceRequest(m: Member, requestId: string) {
	await withTenant(userCtx(m), async (tx) => {
		const found = await load(tx, m.access, requestId, true);
		if (!found) throw notFound();
		const { r, rights } = found;
		if (!rights.canCancel) throw new AppError('forbidden', 'You cannot cancel this request.', 403);
		if (!cancellable(r, dateIn(now(), (await calendar(tx, r.employeeId)).timeZone)))
			throw new AppError('not_cancellable', 'Only pending requests or upcoming work from home can be cancelled.', 409);
		await tx.update(attendanceRequests).set({ status: 'cancelled' }).where(eq(attendanceRequests.id, r.id));
	});
}

export async function myAttendanceRequests(tx: Tx, access: Access) {
	if (!access.employeeId) return [];
	const { timeZone } = await calendar(tx, access.employeeId);
	const today = dateIn(now(), timeZone);
	const rows = await tx
		.select()
		.from(attendanceRequests)
		.where(eq(attendanceRequests.employeeId, access.employeeId))
		.orderBy(desc(attendanceRequests.date), desc(attendanceRequests.createdAt))
		.limit(50);
	return rows.map((r) => ({
		id: r.id,
		title: describe(r, timeZone),
		approvedMinutes: r.approvedMinutes,
		status: r.status,
		cancellable: cancellable(r, today)
	}));
}

export async function attendanceApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	const me = access.employeeId;
	const rows = await tx
		.select({ r: attendanceRequests, name: employees.fullName, zone: employeeZone })
		.from(attendanceRequests)
		.innerJoin(employees, eq(employees.id, attendanceRequests.employeeId))
		.leftJoin(departments, eq(departments.id, employees.departmentId))
		.where(and(eq(attendanceRequests.status, 'pending'), await deciderWhere(tx, access, 'attendance')))
		.orderBy(asc(attendanceRequests.createdAt))
		.limit(200);
	const single = rows.some(({ r }) => r.employeeId === me) && (await singleAdmin(tx));
	return rows
		.filter(({ r }) => r.employeeId !== me || single)
		.map(({ r, name, zone }) => ({
			id: r.id,
			kind: 'Attendance',
			title: `${name}: ${describe(r, zone)}`,
			requestedBy: name,
			at: r.createdAt,
			link: `approvals/attendance/${r.id}`
		}));
}

export const attendanceAttachments: AttachmentRules = {
	async canRead(tx, access, id) {
		return !!(await load(tx, access, id, false));
	},
	async canEdit(tx, access, id, lock) {
		const q = tx
			.select({ employeeId: attendanceRequests.employeeId, status: attendanceRequests.status })
			.from(attendanceRequests)
			.where(eq(attendanceRequests.id, id));
		const [r] = lock ? await q.for('update') : await q;
		return !!r && r.status === 'pending' && r.employeeId === access.employeeId;
	}
};
