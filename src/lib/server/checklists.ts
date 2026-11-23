import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CHECKLIST_KINDS, checklistTemplateItems, checklistTemplates, roles } from './db/schema';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { AppError } from './errors';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

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
