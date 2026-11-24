import { and, asc, desc, eq, gte, ilike, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { poishaOf } from '../money';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { ASSET_CONDITIONS, ASSET_OUTCOMES, assetAssignments, assets, employees } from './db/schema';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

const optionalDate = (msg: string) =>
	z
		.union([z.literal(''), z.iso.date(msg)])
		.transform((v) => v || null)
		.prefault('');
const money = (msg: string) =>
	z
		.string()
		.trim()
		.regex(/^(\d{1,9}(\.\d{1,2})?)?$/, msg)
		.prefault('')
		.transform((v) => (v ? poishaOf(v) : null));
const condition = z.enum(ASSET_CONDITIONS, 'Choose the condition.');

const assetSchema = z.object({
	assetId: z
		.union([z.literal(''), z.uuid({ error: 'Choose an asset.' })])
		.transform((v) => v || null)
		.prefault(''),
	tag: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Use 2 to 20 letters, digits or dashes for the tag.'),
	name: z.string().trim().min(1, 'Name the asset.').max(120, 'Keep the name under 120 characters.'),
	category: z.string().trim().min(1, 'Choose a category.').max(60, 'Keep the category under 60 characters.'),
	serial: z.string().trim().max(120, 'Keep the serial under 120 characters.').prefault(''),
	purchaseDate: optionalDate('Enter a real purchase date.'),
	purchaseCost: money('Enter the cost, up to 2 decimals.'),
	status: z
		.union([z.literal(''), z.enum(['available', 'repair', 'retired'], 'Choose a status.')])
		.transform((v) => v || null)
		.prefault(''),
	notes: z.string().trim().max(500, 'Keep the notes under 500 characters.').prefault('')
});
const assignSchema = z.object({
	assetId: z.uuid({ error: 'Choose an asset.' }),
	employeeId: z.uuid({ error: 'Choose an employee.' }),
	assignedOn: z.iso.date('Enter the hand-over date.'),
	condition
});
const returnSchema = z
	.object({
		assetId: z.uuid({ error: 'Choose an asset.' }),
		outcome: z.enum(ASSET_OUTCOMES, 'Choose returned or written off.'),
		returnedOn: z.iso.date('Enter the return date.'),
		condition: condition.optional().or(z.literal('').transform(() => undefined)),
		charge: money('Enter the charge, up to 2 decimals.').transform((v) => v ?? 0),
		note: z.string().trim().max(300, 'Keep the note under 300 characters.').prefault('')
	})
	.refine((v) => v.outcome !== 'returned' || v.condition, { message: 'Choose the condition it came back in.' })
	.refine((v) => v.outcome !== 'written_off' || v.note, { message: 'Say what happened to the asset.' });

const notFound = () => new AppError('not_found', 'That asset does not exist.', 404);
export const canRunAssets = (access: Access) => scopesOf(access, 'asset.manage').includes('all');
const onlyManagers = (access: Access) => {
	if (!canRunAssets(access)) throw new AppError('forbidden', 'Only asset managers can change assets.', 403);
};

const holder = sql<
	string | null
>`(select aa.employee_id from asset_assignments aa where aa.asset_id = assets.id and aa.returned_on is null)`;
const holderName = sql<
	string | null
>`(select e.full_name from asset_assignments aa join employees e on e.id = aa.employee_id where aa.asset_id = assets.id and aa.returned_on is null)`;

export const assetAttachments = {
	async canRead(tx: Tx, access: Access, id: string) {
		const found = await tx
			.select({ id: assets.id })
			.from(assets)
			.where(and(eq(assets.id, id), await visibleAssets(tx, access)));
		return found.length > 0;
	},
	async canEdit(tx: Tx, access: Access, id: string, lock: boolean) {
		if (!canRunAssets(access)) return false;
		const q = tx.select({ id: assets.id }).from(assets).where(eq(assets.id, id));
		return (lock ? await q.for('update') : await q).length > 0;
	}
};

async function visibleAssets(tx: Tx, access: Access): Promise<SQL> {
	const scope = await resolveScope(tx, access, 'asset.read');
	if (scope.kind === 'all') return sql`true`;
	return scope.ids.length
		? sql`exists (select 1 from asset_assignments aa where aa.asset_id = ${assets.id} and aa.returned_on is null and aa.employee_id in ${scope.ids})`
		: sql`false`;
}

export async function saveAsset(m: Member, raw: Record<string, string>) {
	const { assetId, ...input } = assetSchema.parse(raw);
	onlyManagers(m.access);
	return withTenant(userCtx(m), async (tx) => {
		if (input.purchaseDate && input.purchaseDate > (await tenantToday(tx)))
			throw new AppError('future', 'The purchase date cannot be in the future.', 400);
		const clash = (err: unknown) => {
			if (pgCode(err) === UNIQUE_VIOLATION)
				throw new AppError('tag_exists', 'Another asset already uses that tag.', 409);
			throw err;
		};
		if (!assetId) {
			const [a] = await tx
				.insert(assets)
				.values({
					tenantId: m.tenant.id,
					...input,
					status: input.status ?? 'available',
					createdByUserId: m.user.userId
				})
				.returning({ id: assets.id })
				.catch(clash);
			return a.id;
		}
		const [current] = await tx
			.select({ status: assets.status })
			.from(assets)
			.where(eq(assets.id, assetId))
			.for('update');
		if (!current) throw notFound();
		if (current.status === 'assigned' && input.status)
			throw new AppError('assigned', 'Take the asset back before changing its status.', 409);
		await tx
			.update(assets)
			.set({ ...input, status: input.status ?? current.status })
			.where(eq(assets.id, assetId))
			.catch(clash);
		return assetId;
	});
}

async function lockedAsset(tx: Tx, id: string) {
	const [a] = await tx.select().from(assets).where(eq(assets.id, id)).for('update');
	if (!a) throw notFound();
	return a;
}

export async function assignAsset(m: Member, raw: Record<string, string>) {
	const input = assignSchema.parse(raw);
	onlyManagers(m.access);
	await withTenant(userCtx(m), async (tx) => {
		const a = await lockedAsset(tx, input.assetId);
		if (a.status !== 'available') throw new AppError('not_available', `${a.tag} is not available to hand out.`, 409);
		const [e] = await tx
			.select({ status: employees.status, joinDate: employees.joinDate })
			.from(employees)
			.where(eq(employees.id, input.employeeId));
		if (!e || e.status === 'exited') throw new AppError('invalid_employee', 'Choose a current employee.', 400);
		if (input.assignedOn > (await tenantToday(tx)))
			throw new AppError('future', 'The hand-over date cannot be in the future.', 400);
		await tx.insert(assetAssignments).values({
			tenantId: m.tenant.id,
			assetId: a.id,
			employeeId: input.employeeId,
			assignedOn: input.assignedOn,
			conditionOut: input.condition,
			assignedByUserId: m.user.userId
		});
		await tx.update(assets).set({ status: 'assigned' }).where(eq(assets.id, a.id));
	});
}

export async function returnAsset(m: Member, raw: Record<string, string>) {
	const input = returnSchema.parse(raw);
	onlyManagers(m.access);
	await withTenant(userCtx(m), async (tx) => {
		const a = await lockedAsset(tx, input.assetId);
		const [open] = await tx
			.select({ id: assetAssignments.id, assignedOn: assetAssignments.assignedOn })
			.from(assetAssignments)
			.where(and(eq(assetAssignments.assetId, a.id), isNull(assetAssignments.returnedOn)));
		if (!open) throw new AppError('not_assigned', `${a.tag} is not with anyone.`, 409);
		if (input.returnedOn < open.assignedOn)
			throw new AppError('before_assigned', 'The return date cannot be before the hand-over.', 400);
		if (input.returnedOn > (await tenantToday(tx)))
			throw new AppError('future', 'The return date cannot be in the future.', 400);
		const returned = input.outcome === 'returned';
		await tx
			.update(assetAssignments)
			.set({
				returnedOn: input.returnedOn,
				outcome: input.outcome,
				conditionIn: returned ? input.condition : null,
				charge: input.charge,
				returnNote: input.note,
				closedByUserId: m.user.userId
			})
			.where(eq(assetAssignments.id, open.id));
		const status = !returned ? 'lost' : input.condition === 'damaged' ? 'repair' : 'available';
		await tx.update(assets).set({ status }).where(eq(assets.id, a.id));
	});
}

export async function assetList(tx: Tx, access: Access, filter: { q?: string | null; status?: string | null }) {
	const q = (filter.q ?? '').trim().slice(0, 60);
	const status = z.enum(['available', 'assigned', 'repair', 'retired', 'lost']).safeParse(filter.status);
	return tx
		.select({
			id: assets.id,
			tag: assets.tag,
			name: assets.name,
			category: assets.category,
			status: assets.status,
			holder: holderName
		})
		.from(assets)
		.where(
			and(
				await visibleAssets(tx, access),
				status.success ? eq(assets.status, status.data) : undefined,
				q
					? or(
							ilike(assets.tag, `%${q}%`),
							ilike(assets.name, `%${q}%`),
							ilike(assets.serial, `%${q}%`),
							ilike(assets.category, `%${q}%`)
						)
					: undefined
			)
		)
		.orderBy(asc(assets.tag))
		.limit(500);
}

export async function assetView(tx: Tx, access: Access, id: string) {
	if (!z.uuid().safeParse(id).success) return null;
	const [asset] = await tx
		.select({ asset: assets, holder })
		.from(assets)
		.where(and(eq(assets.id, id), await visibleAssets(tx, access)));
	if (!asset) return null;
	const canManage = canRunAssets(access);
	const scope = await resolveScope(tx, access, 'asset.read');
	const history = await tx
		.select({
			id: assetAssignments.id,
			name: employees.fullName,
			assignedOn: assetAssignments.assignedOn,
			conditionOut: assetAssignments.conditionOut,
			returnedOn: assetAssignments.returnedOn,
			conditionIn: assetAssignments.conditionIn,
			outcome: assetAssignments.outcome,
			charge: assetAssignments.charge,
			note: assetAssignments.returnNote
		})
		.from(assetAssignments)
		.innerJoin(employees, eq(employees.id, assetAssignments.employeeId))
		.where(and(eq(assetAssignments.assetId, id), scopeWhere(scope, assetAssignments.employeeId)))
		.orderBy(desc(assetAssignments.assignedOn), desc(assetAssignments.createdAt));
	const people = canManage
		? await tx
				.select({ id: employees.id, name: employees.fullName })
				.from(employees)
				.where(ne(employees.status, 'exited'))
				.orderBy(asc(employees.fullName))
		: [];
	return { ...asset, history, people, canManage, today: await tenantToday(tx) };
}

export async function assetsOut(tx: Tx, employeeId: string) {
	const [{ n }] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(assetAssignments)
		.where(and(eq(assetAssignments.employeeId, employeeId), isNull(assetAssignments.returnedOn)));
	return n;
}

export async function assetCharges(tx: Tx, employeeId: string) {
	const [{ total }] = await tx
		.select({ total: sql<number>`coalesce(sum(${assetAssignments.charge}), 0)::int` })
		.from(assetAssignments)
		.innerJoin(employees, eq(employees.id, assetAssignments.employeeId))
		.where(and(eq(assetAssignments.employeeId, employeeId), gte(assetAssignments.returnedOn, employees.joinDate)));
	return total;
}
