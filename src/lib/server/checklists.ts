import { and, asc, count, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { addDays } from './dates';
import {
	CHECKLIST_KINDS,
	checklistItems,
	checklists,
	checklistTemplateItems,
	checklistTemplates,
	employees,
	roles
} from './db/schema';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Kind = (typeof CHECKLIST_KINDS)[number];
const PERSONAL_ROLES = ['employee', 'line_manager'];

export const MAX_TEMPLATE_ITEMS = 50;

const id = z.uuid({ error: 'That checklist does not exist.' });
const templateSchema = z.object({
	kind: z.enum(CHECKLIST_KINDS, { error: 'Choose onboarding or offboarding.' }),
	name: z.string().trim().min(1, 'Enter a name.').max(120, 'Keep the name under 120 characters.')
});
const itemSchema = z.object({
	title: z.string().trim().min(1, 'Enter the task.').max(200, 'Keep the task under 200 characters.'),
	assigneeRole: z.string().trim().min(1, 'Choose who does it.'),
	dueOffsetDays: z.coerce
		.number()
		.int('Use whole days.')
		.min(-90, 'Use -90 to 365 days.')
		.max(365, 'Use -90 to 365 days.')
});
const notFound = () => new AppError('not_found', 'That checklist does not exist.', 404);

export async function listTemplates(tx: Tx) {
	const templates = await tx
		.select()
		.from(checklistTemplates)
		.orderBy(asc(checklistTemplates.kind), asc(checklistTemplates.name));
	const items = await tx
		.select()
		.from(checklistTemplateItems)
		.orderBy(asc(checklistTemplateItems.dueOffsetDays), asc(checklistTemplateItems.createdAt));
	const roleRows = await tx.select({ key: roles.key, name: roles.name }).from(roles).orderBy(asc(roles.name));
	return {
		templates: templates.map((t) => ({ ...t, items: items.filter((i) => i.templateId === t.id) })),
		roles: roleRows
	};
}

export async function createTemplate(ctx: TenantCtx, raw: Record<string, string>) {
	const input = templateSchema.parse(raw);
	await withTenant(ctx, (tx) =>
		tx
			.insert(checklistTemplates)
			.values({ tenantId: ctx.tenantId, ...input })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('duplicate', 'A checklist with that name already exists.', 409);
				throw err;
			})
	);
}

async function lockTemplate(tx: Tx, templateId: string) {
	const parsed = id.safeParse(templateId);
	const [t] = parsed.success
		? await tx.select().from(checklistTemplates).where(eq(checklistTemplates.id, parsed.data)).for('update')
		: [];
	if (!t) throw notFound();
	return t;
}

export async function addTemplateItem(ctx: TenantCtx, templateId: string, raw: Record<string, string>) {
	const input = itemSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const t = await lockTemplate(tx, templateId);
		const [role] = await tx.select({ key: roles.key }).from(roles).where(eq(roles.key, input.assigneeRole));
		if (!role) throw new AppError('unknown_role', 'Choose a role that exists.', 400);
		const [{ n }] = await tx
			.select({ n: count() })
			.from(checklistTemplateItems)
			.where(eq(checklistTemplateItems.templateId, t.id));
		if (n >= MAX_TEMPLATE_ITEMS)
			throw new AppError('too_many', `A checklist can hold up to ${MAX_TEMPLATE_ITEMS} tasks.`, 409);
		await tx.insert(checklistTemplateItems).values({ tenantId: ctx.tenantId, templateId: t.id, ...input });
	});
}

export async function removeTemplateItem(ctx: TenantCtx, templateId: string, itemId: string) {
	const parsed = id.safeParse(itemId);
	if (!parsed.success) throw notFound();
	await withTenant(ctx, async (tx) => {
		const t = await lockTemplate(tx, templateId);
		const gone = await tx
			.delete(checklistTemplateItems)
			.where(and(eq(checklistTemplateItems.id, parsed.data), eq(checklistTemplateItems.templateId, t.id)))
			.returning({ id: checklistTemplateItems.id });
		if (!gone.length) throw notFound();
	});
}

export async function setTemplateActive(ctx: TenantCtx, templateId: string, active: boolean) {
	await withTenant(ctx, async (tx) => {
		const t = await lockTemplate(tx, templateId);
		await tx.update(checklistTemplates).set({ active }).where(eq(checklistTemplates.id, t.id));
	});
}

export async function startChecklists(tx: Tx, tenantId: string, employeeId: string, kind: Kind, anchorDate: string) {
	const templates = await tx
		.select({ id: checklistTemplates.id, name: checklistTemplates.name })
		.from(checklistTemplates)
		.where(and(eq(checklistTemplates.kind, kind), eq(checklistTemplates.active, true)));
	if (!templates.length) return;
	const started = await tx
		.insert(checklists)
		.values(templates.map((t) => ({ tenantId, employeeId, templateId: t.id, kind, name: t.name, anchorDate })))
		.onConflictDoNothing()
		.returning({ id: checklists.id, templateId: checklists.templateId });
	if (!started.length) return;
	const items = await tx
		.select()
		.from(checklistTemplateItems)
		.where(
			inArray(
				checklistTemplateItems.templateId,
				started.map((c) => c.templateId)
			)
		);
	const byTemplate = new Map(started.map((c) => [c.templateId, c.id]));
	if (items.length)
		await tx.insert(checklistItems).values(
			items.map((i) => ({
				tenantId,
				checklistId: byTemplate.get(i.templateId)!,
				title: i.title,
				assigneeRole: i.assigneeRole,
				dueDate: addDays(anchorDate, i.dueOffsetDays)
			}))
		);
}

export async function moveOffboarding(tx: Tx, employeeId: string, from: string, to: string) {
	const moved = await tx
		.update(checklists)
		.set({ anchorDate: to })
		.where(
			and(eq(checklists.employeeId, employeeId), eq(checklists.kind, 'offboarding'), eq(checklists.anchorDate, from))
		)
		.returning({ id: checklists.id });
	if (moved.length)
		await tx
			.update(checklistItems)
			.set({ dueDate: sql`${checklistItems.dueDate} + (${to}::date - ${from}::date)` })
			.where(
				inArray(
					checklistItems.checklistId,
					moved.map((c) => c.id)
				)
			);
}

export async function dropOffboarding(tx: Tx, employeeId: string, anchorDate: string) {
	await tx
		.delete(checklists)
		.where(
			and(
				eq(checklists.employeeId, employeeId),
				eq(checklists.kind, 'offboarding'),
				eq(checklists.anchorDate, anchorDate)
			)
		);
}

function assignedTo(access: Access): SQL {
	const byRole = and(
		inArray(checklistItems.assigneeRole, access.roleKeys.length ? access.roleKeys : ['']),
		notInArray(checklistItems.assigneeRole, PERSONAL_ROLES)
	)!;
	if (!access.employeeId) return byRole;
	return or(
		byRole,
		and(eq(checklistItems.assigneeRole, 'employee'), eq(checklists.employeeId, access.employeeId)),
		and(eq(checklistItems.assigneeRole, 'line_manager'), eq(employees.managerId, access.employeeId))
	)!;
}

function canDo(access: Access, item: { assigneeRole: string }, e: { id: string; managerId: string | null }) {
	if (item.assigneeRole === 'employee') return access.employeeId === e.id;
	if (item.assigneeRole === 'line_manager') return !!access.employeeId && access.employeeId === e.managerId;
	return access.roleKeys.includes(item.assigneeRole);
}

const taskColumns = {
	id: checklistItems.id,
	title: checklistItems.title,
	assigneeRole: checklistItems.assigneeRole,
	dueDate: checklistItems.dueDate,
	checklist: checklists.name,
	kind: checklists.kind,
	employeeId: employees.id,
	employeeName: employees.fullName,
	employeeCode: employees.code
};

async function taskList(tx: Tx, where: SQL) {
	const today = await tenantToday(tx);
	const rows = await tx
		.select(taskColumns)
		.from(checklistItems)
		.innerJoin(checklists, eq(checklists.id, checklistItems.checklistId))
		.innerJoin(employees, eq(employees.id, checklists.employeeId))
		.where(and(isNull(checklistItems.doneAt), where))
		.orderBy(asc(checklistItems.dueDate), asc(employees.code), asc(checklistItems.createdAt))
		.limit(200);
	return rows.map((r) => ({ ...r, overdue: r.dueDate < today }));
}

export const myTasks = (tx: Tx, access: Access) => taskList(tx, assignedTo(access));

export async function scopeTasks(tx: Tx, access: Access) {
	const scope = await resolveScope(tx, access, 'employee.update');
	return taskList(tx, scopeWhere(scope, employees.id));
}

export async function employeeChecklists(tx: Tx, access: Access, e: { id: string; managerId: string | null }) {
	const lists = await tx
		.select()
		.from(checklists)
		.where(eq(checklists.employeeId, e.id))
		.orderBy(asc(checklists.anchorDate), asc(checklists.name));
	if (!lists.length) return [];
	const items = await tx
		.select()
		.from(checklistItems)
		.where(
			inArray(
				checklistItems.checklistId,
				lists.map((c) => c.id)
			)
		)
		.orderBy(asc(checklistItems.dueDate), asc(checklistItems.createdAt));
	const hr = inScope(await resolveScope(tx, access, 'employee.update'), e.id);
	return lists.map((c) => ({
		id: c.id,
		name: c.name,
		kind: c.kind,
		anchorDate: c.anchorDate,
		items: items
			.filter((i) => i.checklistId === c.id)
			.map((i) => ({
				id: i.id,
				title: i.title,
				assigneeRole: i.assigneeRole,
				dueDate: i.dueDate,
				done: !!i.doneAt,
				canComplete: hr || canDo(access, i, e)
			}))
	}));
}

export async function setTaskDone(m: Member, itemId: string, done: boolean) {
	const parsed = id.safeParse(itemId);
	if (!parsed.success) throw new AppError('not_found', 'That task does not exist.', 404);
	await withTenant(userCtx(m), async (tx) => {
		const [row] = await tx
			.select({ item: checklistItems, e: { id: employees.id, managerId: employees.managerId } })
			.from(checklistItems)
			.innerJoin(checklists, eq(checklists.id, checklistItems.checklistId))
			.innerJoin(employees, eq(employees.id, checklists.employeeId))
			.where(eq(checklistItems.id, parsed.data))
			.for('update', { of: checklistItems });
		if (!row) throw new AppError('not_found', 'That task does not exist.', 404);
		const hr = inScope(await resolveScope(tx, m.access, 'employee.update'), row.e.id);
		if (!hr && !canDo(m.access, row.item, row.e)) {
			const seen = inScope(await resolveScope(tx, m.access, 'employee.read'), row.e.id);
			if (!seen) throw new AppError('not_found', 'That task does not exist.', 404);
			throw new AppError('forbidden', 'This task is for someone else.', 403);
		}
		await tx
			.update(checklistItems)
			.set(done ? { doneAt: new Date(), doneByUserId: m.user.userId } : { doneAt: null, doneByUserId: null })
			.where(eq(checklistItems.id, row.item.id));
	});
}

export async function roleNames(tx: Tx): Promise<Record<string, string>> {
	const rows = await tx.select({ key: roles.key, name: roles.name }).from(roles);
	return Object.fromEntries(rows.map((r) => [r.key, r.name]));
}
