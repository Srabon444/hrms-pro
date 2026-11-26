import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import { recomputeAttendance } from './attendance';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { workWeekAssignments, workWeeks } from './db/schema';
import { lockEmployee } from './employees';
import { advisoryLock, LOCK } from './locks';
import { AppError } from './errors';
import { recountEmployeeLeave } from './leave-requests';
import { tenantToday } from './lifecycle';
import { payrollClosedFrom } from './payroll';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { tenantWeekend } from './rest-days';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

const weekSchema = z.object({
	name: z.string().trim().min(1, 'Enter a name.').max(60, 'Keep the name under 60 characters.'),
	weekendDays: z
		.array(z.string().regex(/^[0-6]$/, 'Pick weekend days from the list.'))
		.transform((d) => [...new Set(d.map(Number))].sort())
		.refine((d) => d.length <= 6, 'At least one working day is needed.'),
	rosterMode: z.preprocess((v) => v === 'on' || v === true, z.boolean()),
	active: z.preprocess((v) => v === 'on' || v === true, z.boolean())
});

type WeekForm = { name: string; weekendDays: string[]; rosterMode?: string; active?: string };

const duplicate = (err: unknown) => {
	if (pgCode(err) === UNIQUE_VIOLATION)
		throw new AppError('duplicate', 'A work week with that name already exists.', 409);
	throw err;
};

export async function listWorkWeeks(tx: Tx) {
	const weeks = await tx.select().from(workWeeks).orderBy(asc(workWeeks.name));
	const used = new Set(
		(await tx.selectDistinct({ id: workWeekAssignments.workWeekId }).from(workWeekAssignments)).map((r) => r.id)
	);
	return weeks.map((w) => ({ ...w, used: used.has(w.id) }));
}

export async function createWorkWeek(ctx: TenantCtx, raw: WeekForm) {
	const input = weekSchema.parse(raw);
	await withTenant(ctx, (tx) =>
		tx
			.insert(workWeeks)
			.values({ tenantId: ctx.tenantId, ...input })
			.catch(duplicate)
	);
}

export async function updateWorkWeek(ctx: TenantCtx, workWeekId: string, raw: WeekForm) {
	const id = z.uuid().safeParse(workWeekId);
	const input = weekSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const [w] = id.success ? await tx.select().from(workWeeks).where(eq(workWeeks.id, id.data)).for('update') : [];
		if (!w) throw new AppError('not_found', 'That work week does not exist.', 404);
		const [used] = await tx
			.select({ id: workWeekAssignments.id })
			.from(workWeekAssignments)
			.where(eq(workWeekAssignments.workWeekId, w.id))
			.limit(1);
		if (used && (input.weekendDays.join() !== w.weekendDays.join() || input.rosterMode !== w.rosterMode))
			throw new AppError(
				'in_use',
				'People already follow this work week, so its days and roster setting cannot change. Add a new work week and assign it instead.',
				409
			);
		await tx.update(workWeeks).set(input).where(eq(workWeeks.id, w.id)).catch(duplicate);
	});
}

async function weekFor(tx: Tx, employeeId: string, date: string) {
	const [row] = await tx
		.select({ name: workWeeks.name, weekendDays: workWeeks.weekendDays })
		.from(workWeekAssignments)
		.innerJoin(workWeeks, eq(workWeeks.id, workWeekAssignments.workWeekId))
		.where(and(eq(workWeekAssignments.employeeId, employeeId), lte(workWeekAssignments.effectiveFrom, date)))
		.orderBy(desc(workWeekAssignments.effectiveFrom))
		.limit(1);
	return row ?? { name: null, weekendDays: await tenantWeekend(tx) };
}

export async function employeeWorkWeek(tx: Tx, access: Access, e: { id: string }, today: string) {
	const canManage = inScope(await resolveScope(tx, access, 'attendance.manage'), e.id);
	if (!canManage && !inScope(await resolveScope(tx, access, 'attendance.read'), e.id)) return null;
	const history = await tx
		.select({
			id: workWeekAssignments.id,
			effectiveFrom: workWeekAssignments.effectiveFrom,
			name: workWeeks.name,
			weekendDays: workWeeks.weekendDays
		})
		.from(workWeekAssignments)
		.innerJoin(workWeeks, eq(workWeeks.id, workWeekAssignments.workWeekId))
		.where(eq(workWeekAssignments.employeeId, e.id))
		.orderBy(desc(workWeekAssignments.effectiveFrom));
	return {
		current: await weekFor(tx, e.id, today),
		history,
		today,
		canManage,
		choices: canManage
			? await tx.select().from(workWeeks).where(eq(workWeeks.active, true)).orderBy(asc(workWeeks.name))
			: []
	};
}

const assignSchema = z.object({
	workWeekId: z.uuid({ error: 'Choose a work week.' }),
	effectiveFrom: z.iso.date('Enter the date the work week starts.')
});

async function changeable(tx: Tx, m: Member, employeeId: string, from: string) {
	await advisoryLock(tx, LOCK.payroll, m.tenant.id);
	const e = await lockEmployee(tx, m.access, employeeId);
	if (!inScope(await resolveScope(tx, m.access, 'attendance.manage'), e.id))
		throw new AppError('forbidden', 'You cannot change the work week for this person.', 403);
	if (from < (await tenantToday(tx)))
		throw new AppError('past_date', 'A work week can only change from today onwards.', 400);
	const closed = await payrollClosedFrom(tx, e.id, from);
	if (closed)
		throw new AppError(
			'payroll_closed',
			`Payroll for ${closed} is already approved, so the days in it cannot change.`,
			409
		);
	return e;
}

async function settle(tx: Tx, tenantId: string, employeeId: string, from: string) {
	await recountEmployeeLeave(tx, employeeId, from);
	await recomputeAttendance(tx, tenantId, from, '9999-12-31', [employeeId]);
}

export async function assignWorkWeek(m: Member, employeeId: string, raw: Record<string, string>) {
	const input = assignSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const e = await changeable(tx, m, employeeId, input.effectiveFrom);
		if (input.effectiveFrom < e.joinDate)
			throw new AppError('before_join', 'The work week cannot start before the join date.', 400);
		if (e.exitDate && input.effectiveFrom > e.exitDate)
			throw new AppError('after_exit', 'The work week cannot start after the exit date.', 400);
		const [w] = await tx.select().from(workWeeks).where(eq(workWeeks.id, input.workWeekId));
		if (!w?.active) throw new AppError('unknown_work_week', 'Choose an active work week.', 400);
		await tx
			.insert(workWeekAssignments)
			.values({ tenantId: m.tenant.id, employeeId: e.id, ...input, createdByUserId: m.user.userId })
			.onConflictDoUpdate({
				target: [workWeekAssignments.tenantId, workWeekAssignments.employeeId, workWeekAssignments.effectiveFrom],
				set: { workWeekId: w.id, createdByUserId: m.user.userId }
			});
		await settle(tx, m.tenant.id, e.id, input.effectiveFrom);
	});
}

export async function removeWorkWeekAssignment(m: Member, employeeId: string, assignmentId: string) {
	const id = z.uuid().safeParse(assignmentId);
	await withTenant(userCtx(m), async (tx) => {
		const [a] = id.success
			? await tx.select().from(workWeekAssignments).where(eq(workWeekAssignments.id, id.data))
			: [];
		if (!a || a.employeeId !== employeeId)
			throw new AppError('not_found', 'That work week assignment does not exist.', 404);
		const e = await changeable(tx, m, employeeId, a.effectiveFrom);
		await tx.delete(workWeekAssignments).where(eq(workWeekAssignments.id, a.id));
		await settle(tx, m.tenant.id, e.id, a.effectiveFrom);
	});
}
