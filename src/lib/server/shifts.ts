import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import { recomputeAttendance } from './attendance';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { shiftAssignments, shifts } from './db/schema';
import { AppError } from './errors';
import { lockEmployee } from './employees';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
export type Shift = typeof shifts.$inferSelect;

export const seedShift = (tx: Tx, tenantId: string) =>
	tx
		.insert(shifts)
		.values({ tenantId, name: 'General', startTime: '09:00', endTime: '18:00', isDefault: true })
		.onConflictDoNothing();

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const shiftSpan = (s: Pick<Shift, 'startTime' | 'endTime'>) =>
	(minutes(s.endTime) - minutes(s.startTime) + 1440) % 1440;

const checkbox = z.preprocess((v) => v === 'on' || v === true, z.boolean());
const clock = (message: string) => z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:00)?$/, message);
const mins = (min: number, max: number, message: string) =>
	z.coerce.number(message).int(message).min(min, message).max(max, message);

const shiftSchema = z
	.object({
		name: z.string().trim().min(1, 'Enter a name.').max(60, 'Keep the name under 60 characters.'),
		startTime: clock('Enter when the shift starts.'),
		endTime: clock('Enter when the shift ends.'),
		graceMinutes: mins(0, 240, 'Grace must be 0 to 240 minutes.'),
		halfDayMinutes: mins(1, 1440, 'Half day must be 1 to 1440 minutes.'),
		fullDayMinutes: mins(1, 1440, 'Full day must be 1 to 1440 minutes.'),
		breakMinutes: z.preprocess(
			(v) => (v === undefined || v === '' ? 0 : v),
			mins(0, 240, 'Break must be 0 to 240 minutes.')
		),
		breakPaid: checkbox,
		isDefault: checkbox,
		active: checkbox
	})
	.refine((s) => s.halfDayMinutes <= s.fullDayMinutes, 'A half day cannot need more time than a full day.')
	.refine(
		(s) => s.fullDayMinutes <= shiftSpan(s) - (s.breakPaid ? 0 : s.breakMinutes),
		'A full day cannot need more time than the shift lasts, less any unpaid break.'
	);

const duplicate = (err: unknown) => {
	if (pgCode(err) === UNIQUE_VIOLATION) throw new AppError('duplicate', 'A shift with that name already exists.', 409);
	throw err;
};

export const listShifts = (tx: Tx) => tx.select().from(shifts).orderBy(desc(shifts.isDefault), asc(shifts.name));

async function makeDefault(tx: Tx, input: { isDefault: boolean; active: boolean }) {
	if (!input.isDefault) return;
	if (!input.active) throw new AppError('inactive_default', 'The default shift must stay active.', 400);
	await tx.update(shifts).set({ isDefault: false }).where(eq(shifts.isDefault, true));
}

export async function createShift(ctx: TenantCtx, raw: Record<string, string>) {
	const input = shiftSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		await makeDefault(tx, input);
		await tx
			.insert(shifts)
			.values({ tenantId: ctx.tenantId, ...input })
			.catch(duplicate);
	});
}

export async function updateShift(ctx: TenantCtx, shiftId: string, raw: Record<string, string>) {
	const id = z.uuid().safeParse(shiftId);
	const input = shiftSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const [s] = id.success ? await tx.select().from(shifts).where(eq(shifts.id, id.data)).for('update') : [];
		if (!s) throw new AppError('not_found', 'That shift does not exist.', 404);
		if (s.isDefault && !input.isDefault)
			throw new AppError('default_required', 'Make another shift the default first.', 409);
		await makeDefault(tx, input);
		await tx.update(shifts).set(input).where(eq(shifts.id, s.id)).catch(duplicate);
	});
}

export async function shiftFor(tx: Tx, employeeId: string, date: string): Promise<Shift | null> {
	const [assigned] = await tx
		.select({ shift: shifts })
		.from(shiftAssignments)
		.innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
		.where(and(eq(shiftAssignments.employeeId, employeeId), lte(shiftAssignments.effectiveFrom, date)))
		.orderBy(desc(shiftAssignments.effectiveFrom))
		.limit(1);
	if (assigned) return assigned.shift;
	const [fallback] = await tx.select().from(shifts).where(eq(shifts.isDefault, true));
	return fallback ?? null;
}

export async function employeeShift(tx: Tx, access: Access, e: { id: string }, today: string) {
	const canManage = inScope(await resolveScope(tx, access, 'attendance.manage'), e.id);
	if (!canManage && !inScope(await resolveScope(tx, access, 'attendance.read'), e.id)) return null;
	const history = await tx
		.select({
			id: shiftAssignments.id,
			effectiveFrom: shiftAssignments.effectiveFrom,
			name: shifts.name,
			startTime: shifts.startTime,
			endTime: shifts.endTime
		})
		.from(shiftAssignments)
		.innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
		.where(eq(shiftAssignments.employeeId, e.id))
		.orderBy(desc(shiftAssignments.effectiveFrom));
	return {
		current: await shiftFor(tx, e.id, today),
		history,
		canManage,
		choices: canManage ? (await listShifts(tx)).filter((s) => s.active) : []
	};
}

const assignSchema = z.object({
	shiftId: z.uuid({ error: 'Choose a shift.' }),
	effectiveFrom: z.iso.date('Enter the date the shift starts.')
});

async function managed(tx: Tx, m: Member, employeeId: string) {
	const e = await lockEmployee(tx, m.access, employeeId);
	if (!inScope(await resolveScope(tx, m.access, 'attendance.manage'), e.id))
		throw new AppError('forbidden', 'You cannot change shifts for this person.', 403);
	return e;
}

export async function assignShift(m: Member, employeeId: string, raw: Record<string, string>) {
	const input = assignSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const e = await managed(tx, m, employeeId);
		if (input.effectiveFrom < e.joinDate)
			throw new AppError('before_join', 'The shift cannot start before the join date.', 400);
		const [s] = await tx.select().from(shifts).where(eq(shifts.id, input.shiftId));
		if (!s?.active) throw new AppError('unknown_shift', 'Choose an active shift.', 400);
		await tx
			.insert(shiftAssignments)
			.values({ tenantId: m.tenant.id, employeeId: e.id, ...input, createdByUserId: m.user.userId })
			.onConflictDoUpdate({
				target: [shiftAssignments.tenantId, shiftAssignments.employeeId, shiftAssignments.effectiveFrom],
				set: { shiftId: s.id, createdByUserId: m.user.userId }
			});
		await recomputeAttendance(tx, m.tenant.id, input.effectiveFrom, '9999-12-31', [e.id]);
	});
}

export async function removeShiftAssignment(m: Member, employeeId: string, assignmentId: string) {
	const id = z.uuid().safeParse(assignmentId);
	await withTenant(userCtx(m), async (tx) => {
		const e = await managed(tx, m, employeeId);
		const gone = id.success
			? await tx
					.delete(shiftAssignments)
					.where(and(eq(shiftAssignments.id, id.data), eq(shiftAssignments.employeeId, e.id)))
					.returning({ effectiveFrom: shiftAssignments.effectiveFrom })
			: [];
		if (!gone.length) throw new AppError('not_found', 'That shift assignment does not exist.', 404);
		await recomputeAttendance(tx, m.tenant.id, gone[0].effectiveFrom, '9999-12-31', [e.id]);
	});
}
