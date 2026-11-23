import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { rolloverIncomplete } from '../domain/workplan/rollover';
import { addDays } from './dates';
import { employees, WORK_PLAN_STATUSES, workPlanItems } from './db/schema';
import { AppError } from './errors';
import { tenantWeeks } from './lifecycle';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

const scopeOf = (tx: Tx, access: Access) => resolveScope(tx, access, 'report.weekly');
const itemId = z.uuid({ error: 'Choose an item.' });
const weekStart = z.iso.date('Choose a week.');
const itemSchema = z.object({
	employeeId: z.uuid({ error: 'Choose who owns this item.' }),
	weekStart,
	description: z.string().trim().min(1, 'Describe the item.').max(300, 'Keep the item under 300 characters.'),
	target: z.string().trim().max(120, 'Keep the target under 120 characters.').prefault('')
});
const notFound = () => new AppError('not_found', 'That item does not exist.', 404);

async function startOf(tx: Tx, week: string, message: string) {
	const w = await tenantWeeks(tx);
	if (w.of(week) !== week) throw new AppError('not_week_start', 'Choose a week.', 400);
	if (week < w.current) throw new AppError('past_week', message, 409);
}

export async function workPlan(tx: Tx, access: Access, requested: string | null) {
	const w = await tenantWeeks(tx);
	const week = requested && weekStart.safeParse(requested).success ? w.of(requested) : w.current;
	const scope = await scopeOf(tx, access);
	const items = await tx
		.select({
			id: workPlanItems.id,
			employeeId: workPlanItems.employeeId,
			name: employees.fullName,
			description: workPlanItems.description,
			target: workPlanItems.target,
			status: workPlanItems.status,
			carried: workPlanItems.carriedOverFromId
		})
		.from(workPlanItems)
		.innerJoin(employees, eq(employees.id, workPlanItems.employeeId))
		.where(and(eq(workPlanItems.weekStart, week), scopeWhere(scope, workPlanItems.employeeId)))
		.orderBy(asc(employees.fullName), asc(workPlanItems.createdAt), asc(workPlanItems.id));
	const people = await tx
		.select({ id: employees.id, name: employees.fullName })
		.from(employees)
		.where(and(ne(employees.status, 'exited'), scopeWhere(scope, employees.id)))
		.orderBy(asc(employees.fullName));
	const next = addDays(week, 7);
	return {
		week,
		current: w.current,
		previous: addDays(week, -7),
		next,
		items,
		people,
		me: access.employeeId,
		canPlan: week >= w.current && people.length > 0,
		canRoll: next >= w.current && items.some((i) => i.status !== 'done')
	};
}

export async function addItem(m: Member, raw: Record<string, string>) {
	const input = itemSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		await startOf(tx, input.weekStart, 'Plan this week or a later one.');
		const [e] = await tx.select({ status: employees.status }).from(employees).where(eq(employees.id, input.employeeId));
		if (!e || e.status === 'exited' || !inScope(await scopeOf(tx, m.access), input.employeeId))
			throw new AppError('invalid_owner', 'Choose someone you can plan for.', 400);
		await tx.insert(workPlanItems).values({ tenantId: m.tenant.id, ...input, createdByUserId: m.user.userId });
	});
}

async function scopedItem(tx: Tx, access: Access, id: string) {
	const [item] = await tx.select().from(workPlanItems).where(eq(workPlanItems.id, id)).for('update');
	if (!item || !inScope(await scopeOf(tx, access), item.employeeId)) throw notFound();
	return item;
}

export async function setItemStatus(m: Member, raw: Record<string, string>) {
	const input = z
		.object({ itemId, status: z.enum(WORK_PLAN_STATUSES, 'Choose pending, in progress or done.') })
		.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		await scopedItem(tx, m.access, input.itemId);
		await tx.update(workPlanItems).set({ status: input.status }).where(eq(workPlanItems.id, input.itemId));
	});
}

export async function removeItem(m: Member, raw: Record<string, string>) {
	const id = itemId.parse(raw.itemId);
	await withTenant(userCtx(m), async (tx) => {
		await scopedItem(tx, m.access, id);
		await tx.delete(workPlanItems).where(eq(workPlanItems.id, id));
	});
}

export async function rolloverWeek(m: Member, raw: Record<string, string>) {
	const week = weekStart.parse(raw.weekStart);
	const next = addDays(week, 7);
	return withTenant(userCtx(m), async (tx) => {
		await startOf(tx, next, 'Carry items into this week or a later one.');
		const open = await tx
			.select({
				id: workPlanItems.id,
				employeeId: workPlanItems.employeeId,
				description: workPlanItems.description,
				target: workPlanItems.target,
				status: workPlanItems.status
			})
			.from(workPlanItems)
			.innerJoin(employees, eq(employees.id, workPlanItems.employeeId))
			.where(
				and(
					eq(workPlanItems.weekStart, week),
					ne(employees.status, 'exited'),
					scopeWhere(await scopeOf(tx, m.access), workPlanItems.employeeId)
				)
			);
		const carried = rolloverIncomplete(open, next);
		if (!carried.length) return { next, count: 0 };
		const rows = await tx
			.insert(workPlanItems)
			.values(carried.map((c) => ({ tenantId: m.tenant.id, ...c, createdByUserId: m.user.userId })))
			.onConflictDoNothing()
			.returning({ id: workPlanItems.id });
		return { next, count: rows.length };
	});
}
