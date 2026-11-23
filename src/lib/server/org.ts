import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { branches, departments, designations, grades, holidays } from './db/schema';
import { FK_VIOLATION, pgCode, UNIQUE_VIOLATION } from './db/errors';
import { AppError } from './errors';
import { recomputeAttendance } from './attendance';
import { dropHolidayFromLeave } from './leave-requests';
import { advisoryLock, LOCK } from './locks';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

const TABLES = { branch: branches, department: departments, designation: designations, grade: grades };
export type OrgKind = keyof typeof TABLES;
export const ORG_KINDS = Object.keys(TABLES) as OrgKind[];
export const isOrgKind = (v: string): v is OrgKind => v in TABLES;

const nameSchema = z.string().trim().min(1, 'Enter a name.').max(120, 'Keep the name under 120 characters.');
const optionalId = z.preprocess((v) => (v === '' ? null : v), z.uuid().nullable());

const itemSchema = z.object({
	name: nameSchema,
	parentId: optionalId.optional(),
	address: z.string().trim().max(300).optional(),
	rank: z.coerce.number().int().min(0).max(1000).optional()
});

export type OrgItemInput = { name: string; parentId?: string; address?: string; rank?: string | number };

async function guarded<T>(fn: () => Promise<T>, what: string): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		const code = pgCode(err);
		if (code === UNIQUE_VIOLATION) throw new AppError('duplicate', `A ${what} with that name already exists.`, 409);
		if (code === FK_VIOLATION) throw new AppError('in_use', `That ${what} is still in use.`, 409);
		throw err;
	}
}

async function checkParent(tx: Tx, tenantId: string, id: string | null, parentId: string | null | undefined) {
	if (!parentId) return;
	await advisoryLock(tx, LOCK.orgTree, tenantId);
	const [parent] = await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, parentId));
	if (!parent) throw new AppError('parent_not_found', 'The parent department does not exist.', 404);
	if (!id) return;
	const loop = await tx.execute<{ id: string }>(sql`
		with recursive up(id, depth) as (
			select ${parentId}::uuid, 0
			union all
			select d.parent_id, up.depth + 1 from departments d join up on d.id = up.id
			where d.parent_id is not null and up.depth < 50
		)
		select id from up where id = ${id}::uuid limit 1`);
	if (loop.length) throw new AppError('department_cycle', 'A department cannot sit under itself.', 409);
}

const LABEL: Record<OrgKind, string> = {
	branch: 'branch',
	department: 'department',
	designation: 'designation',
	grade: 'grade'
};

function values(kind: OrgKind, input: z.output<typeof itemSchema>) {
	if (kind === 'department') return { name: input.name, parentId: input.parentId ?? null };
	if (kind === 'branch') return { name: input.name, address: input.address || null };
	if (kind === 'grade') return { name: input.name, rank: input.rank ?? 0 };
	return { name: input.name };
}

export async function addOrgItem(ctx: TenantCtx, kind: OrgKind, raw: OrgItemInput): Promise<string> {
	const input = itemSchema.parse(raw);
	return guarded(
		() =>
			withTenant(ctx, async (tx) => {
				if (kind === 'department') await checkParent(tx, ctx.tenantId, null, input.parentId);
				const table = TABLES[kind];
				const [row] = await tx
					.insert(table)
					.values({ tenantId: ctx.tenantId, ...values(kind, input) } as typeof table.$inferInsert)
					.returning({ id: table.id });
				return row.id;
			}),
		LABEL[kind]
	);
}

export async function updateOrgItem(ctx: TenantCtx, kind: OrgKind, id: string, raw: OrgItemInput): Promise<void> {
	const input = itemSchema.parse(raw);
	const itemId = z.uuid().parse(id);
	await guarded(
		() =>
			withTenant(ctx, async (tx) => {
				if (kind === 'department') await checkParent(tx, ctx.tenantId, itemId, input.parentId);
				const table = TABLES[kind];
				const done = await tx
					.update(table)
					.set(values(kind, input))
					.where(eq(table.id, itemId))
					.returning({ id: table.id });
				if (!done.length) throw new AppError('not_found', `That ${LABEL[kind]} does not exist.`, 404);
			}),
		LABEL[kind]
	);
}

export async function removeOrgItem(ctx: TenantCtx, kind: OrgKind, id: string): Promise<void> {
	const itemId = z.uuid().parse(id);
	await guarded(
		() =>
			withTenant(ctx, async (tx) => {
				const table = TABLES[kind];
				const done = await tx.delete(table).where(eq(table.id, itemId)).returning({ id: table.id });
				if (!done.length) throw new AppError('not_found', `That ${LABEL[kind]} does not exist.`, 404);
			}),
		LABEL[kind]
	);
}

export async function orgStructure(tx: Tx) {
	const [b, d, des, g] = await Promise.all([
		tx
			.select({ id: branches.id, name: branches.name, address: branches.address })
			.from(branches)
			.orderBy(asc(branches.name)),
		tx
			.select({ id: departments.id, name: departments.name, parentId: departments.parentId })
			.from(departments)
			.orderBy(asc(departments.name)),
		tx.select({ id: designations.id, name: designations.name }).from(designations).orderBy(asc(designations.name)),
		tx
			.select({ id: grades.id, name: grades.name, rank: grades.rank })
			.from(grades)
			.orderBy(asc(grades.rank), asc(grades.name))
	]);
	return { branches: b, departments: d, designations: des, grades: g };
}

const holidaySchema = z.object({
	date: z.iso.date('Pick a valid date.'),
	name: nameSchema
});

export async function addHoliday(ctx: TenantCtx, raw: { date: string; name: string }): Promise<void> {
	const input = holidaySchema.parse(raw);
	try {
		await withTenant(ctx, async (tx) => {
			await tx.insert(holidays).values({ tenantId: ctx.tenantId, ...input });
			await dropHolidayFromLeave(tx, input.date);
			await recomputeAttendance(tx, ctx.tenantId, input.date, input.date);
		});
	} catch (err) {
		if (pgCode(err) === UNIQUE_VIOLATION) throw new AppError('duplicate', 'That date is already a holiday.', 409);
		throw err;
	}
}

export async function removeHoliday(ctx: TenantCtx, id: string): Promise<void> {
	const holidayId = z.uuid().parse(id);
	await withTenant(ctx, async (tx) => {
		const [gone] = await tx.delete(holidays).where(eq(holidays.id, holidayId)).returning({ date: holidays.date });
		if (gone) await recomputeAttendance(tx, ctx.tenantId, gone.date, gone.date);
	});
}

export const holidaysOf = (tx: Tx, year: number) =>
	tx
		.select({ id: holidays.id, date: holidays.date, name: holidays.name })
		.from(holidays)
		.where(and(gte(holidays.date, `${year}-01-01`), lt(holidays.date, `${year + 1}-01-01`)))
		.orderBy(asc(holidays.date));
