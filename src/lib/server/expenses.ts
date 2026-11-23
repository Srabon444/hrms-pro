import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { poishaOf, taka } from '../money';
import { activeMemberships, singleAdmin } from './approval-chain';
import type { ApprovalItem } from './approvals';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import {
	EXPENSE_PAY_VIA,
	expenseCategories,
	expenseClaims,
	expenseItems,
	employees,
	MAX_DOCUMENT_BYTES,
	MAX_EXPENSE_ITEMS
} from './db/schema';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { log } from './log';
import { notify } from './notifications';
import { can, userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { sniffType } from './sniff';
import { deleteObject, getObject, putObject } from './storage';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Claim = typeof expenseClaims.$inferSelect;

const RECEIPT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

const money = (max: number) =>
	z
		.string()
		.trim()
		.regex(new RegExp(`^\\d{1,${max}}(\\.\\d{1,2})?$`), 'Enter amounts in taka, up to 2 decimals.')
		.transform(poishaOf);

const categorySchema = z.object({
	name: z.string().trim().min(1, 'Enter the category name.').max(60, 'Keep the name under 60 characters.'),
	claimLimit: z.union([z.literal(''), money(7).refine((p) => p > 0, 'The limit must be more than zero.')]),
	active: z.preprocess((v) => v === 'on', z.boolean())
});

const itemSchema = z.object({
	categoryId: z.uuid({ error: 'Choose a category for every item.' }),
	spentOn: z.iso.date('Enter the date of every item.'),
	description: z.string().trim().min(1, 'Describe every item.').max(200, 'Keep descriptions under 200 characters.'),
	amount: money(7).refine((p) => p > 0, 'Every item must cost more than zero.')
});

const claimSchema = z.object({
	title: z.string().trim().min(1, 'Give the claim a title.').max(120, 'Keep the title under 120 characters.')
});

const decisionSchema = z.object({
	claimId: z.uuid({ error: 'Choose a claim.' }),
	decision: z.enum(['approve', 'reject'], 'Choose approve or reject.'),
	payVia: z.enum(EXPENSE_PAY_VIA, 'Choose how the claim is paid.'),
	note: z.string().trim().max(300, 'Keep the note under 300 characters.')
});

const claimId = z.object({ claimId: z.uuid({ error: 'Choose a claim.' }) });

const notFound = () => new AppError('not_found', 'That claim does not exist.', 404);

export async function saveCategory(m: Member, id: string, form: Record<string, string>) {
	const input = categorySchema.parse(form);
	const values = {
		name: input.name,
		claimLimit: input.claimLimit === '' ? null : input.claimLimit,
		active: input.active
	};
	await withTenant(userCtx(m), async (tx) => {
		const write = id
			? tx.update(expenseCategories).set(values).where(eq(expenseCategories.id, id)).returning()
			: tx
					.insert(expenseCategories)
					.values({ tenantId: m.tenant.id, ...values })
					.returning();
		const rows = await write.catch((err) => {
			if (pgCode(err) === UNIQUE_VIOLATION) throw new AppError('duplicate', 'That category already exists.', 409);
			throw err;
		});
		if (!rows.length) throw new AppError('not_found', 'That category does not exist.', 404);
	});
}

type Receipt = { key: string; name: string; type: string; size: number };

async function storeReceipt(tenantId: string, file: File): Promise<Receipt> {
	if (file.size > MAX_DOCUMENT_BYTES) throw new AppError('too_large', 'Receipts can be at most 10 MB.', 413);
	const bytes = new Uint8Array(await file.arrayBuffer());
	const type = sniffType(bytes, file.name);
	if (!type || !RECEIPT_TYPES.includes(type))
		throw new AppError('unsupported_file', 'Receipts must be a PDF or an image.', 415);
	const key = `t/${tenantId}/receipts/${randomUUID()}`;
	await putObject(key, bytes, type);
	return { key, name: file.name.slice(0, 200) || 'receipt', type, size: bytes.byteLength };
}

export async function submitClaim(m: Member, form: Record<string, string>, files: Map<number, File>) {
	const { title } = claimSchema.parse(form);
	const items: (z.infer<typeof itemSchema> & { index: number })[] = [];
	for (let i = 0; i < MAX_EXPENSE_ITEMS; i++) {
		const keys = ['categoryId', 'spentOn', 'description', 'amount'] as const;
		const row = Object.fromEntries(keys.map((k) => [k, (form[`items.${i}.${k}`] ?? '').trim()]));
		if (keys.every((k) => !row[k]) && !files.get(i)?.size) continue;
		items.push({ index: i, ...itemSchema.parse(row) });
	}
	if (!items.length) throw new AppError('no_items', 'Add at least one item.', 400);
	if ([...files.values()].reduce((sum, f) => sum + f.size, 0) > MAX_DOCUMENT_BYTES)
		throw new AppError('too_large', 'Receipts together can be at most 10 MB.', 413);
	const employeeId = m.access.employeeId;
	if (!employeeId) throw new AppError('no_employee', 'Only employees can claim expenses.', 409);

	const stored: Receipt[] = [];
	try {
		const receipts = new Map<number, Receipt>();
		for (const item of items) {
			const file = files.get(item.index);
			if (!file?.size) continue;
			const receipt = await storeReceipt(m.tenant.id, file);
			stored.push(receipt);
			receipts.set(item.index, receipt);
		}
		return await withTenant(userCtx(m), async (tx) => {
			await validateClaim(tx, employeeId, items);
			const [claim] = await tx
				.insert(expenseClaims)
				.values({
					tenantId: m.tenant.id,
					employeeId,
					title,
					total: items.reduce((sum, i) => sum + i.amount, 0),
					submittedByUserId: m.user.userId
				})
				.returning({ id: expenseClaims.id });
			await tx.insert(expenseItems).values(
				items.map((i) => {
					const r = receipts.get(i.index);
					return {
						tenantId: m.tenant.id,
						claimId: claim.id,
						categoryId: i.categoryId,
						spentOn: i.spentOn,
						description: i.description,
						amount: i.amount,
						receiptKey: r?.key ?? null,
						receiptName: r?.name ?? null,
						receiptType: r?.type ?? null,
						receiptSize: r?.size ?? null
					};
				})
			);
			return claim.id;
		});
	} catch (err) {
		for (const r of stored)
			await deleteObject(r.key).catch((e) => log.error({ err: e, key: r.key }, 'orphan receipt cleanup failed'));
		throw err;
	}
}

async function validateClaim(
	tx: Tx,
	employeeId: string,
	items: { categoryId: string; spentOn: string; amount: number }[]
) {
	const [e] = await tx.select({ status: employees.status }).from(employees).where(eq(employees.id, employeeId));
	if (!e || e.status === 'exited') throw new AppError('exited', 'People who have left cannot claim expenses.', 409);
	const today = await tenantToday(tx);
	if (items.some((i) => i.spentOn > today))
		throw new AppError('future_expense', 'Expenses must already have happened.', 400);
	const categories = await tx
		.select()
		.from(expenseCategories)
		.where(
			and(
				inArray(expenseCategories.id, [...new Set(items.map((i) => i.categoryId))]),
				eq(expenseCategories.active, true)
			)
		);
	for (const i of items)
		if (!categories.some((c) => c.id === i.categoryId))
			throw new AppError('bad_category', 'Choose an active category for every item.', 400);
	for (const c of categories) {
		const spent = items.filter((i) => i.categoryId === c.id).reduce((sum, i) => sum + i.amount, 0);
		if (c.claimLimit !== null && spent > c.claimLimit)
			throw new AppError('over_limit', `${c.name} is limited to ৳${taka(c.claimLimit)} per claim.`, 400);
	}
}

async function tellClaimant(tx: Tx, m: Member, c: Claim, title: string, body?: string) {
	return notify(
		tx,
		m.tenant.id,
		await activeMemberships(tx, c.employeeId),
		{ category: 'approvals', title, body, link: 'expenses' },
		m.tenant.slug
	);
}

const loadClaim = async (tx: Tx, id: string) =>
	(await tx.select().from(expenseClaims).where(eq(expenseClaims.id, id)))[0];

export async function cancelClaim(m: Member, form: Record<string, string>) {
	const input = claimId.parse(form);
	await withTenant(userCtx(m), async (tx) => {
		const c = await loadClaim(tx, input.claimId);
		if (!c || c.employeeId !== m.access.employeeId) throw notFound();
		if (c.status !== 'submitted') throw new AppError('decided', 'Only a claim still waiting can be cancelled.', 409);
		await tx.update(expenseClaims).set({ status: 'cancelled' }).where(eq(expenseClaims.id, c.id));
	});
}

export async function decideClaim(m: Member, form: Record<string, string>) {
	const input = decisionSchema.parse(form);
	return withTenant(userCtx(m), async (tx) => {
		const [c] = await tx.select().from(expenseClaims).where(eq(expenseClaims.id, input.claimId)).for('update');
		if (!c || !inScope(await resolveScope(tx, m.access, 'expense.approve'), c.employeeId)) throw notFound();
		if (c.status !== 'submitted') throw new AppError('decided', 'That claim is already decided.', 409);
		if (c.employeeId === m.access.employeeId && !(await singleAdmin(tx)))
			throw new AppError('own_claim', 'Someone else must decide your own claim.', 403);
		const approved = input.decision === 'approve';
		await tx
			.update(expenseClaims)
			.set({
				status: approved ? 'approved' : 'rejected',
				payVia: approved ? input.payVia : null,
				decidedByUserId: m.user.userId,
				decidedAt: new Date(),
				decisionNote: input.note || null
			})
			.where(eq(expenseClaims.id, c.id));
		const how = input.payVia === 'payroll' ? 'It will be paid with your salary.' : 'It will be paid to you directly.';
		return tellClaimant(
			tx,
			m,
			c,
			`Expense claim ${approved ? 'approved' : 'rejected'}: ${c.title}`,
			approved ? `৳${taka(c.total)} was approved. ${how}` : input.note || undefined
		);
	});
}

export async function payClaim(m: Member, form: Record<string, string>) {
	const input = claimId.parse(form);
	return withTenant(userCtx(m), async (tx) => {
		const [c] = await tx.select().from(expenseClaims).where(eq(expenseClaims.id, input.claimId)).for('update');
		if (!c || !inScope(await resolveScope(tx, m.access, 'expense.pay'), c.employeeId)) throw notFound();
		if (c.status !== 'approved' || c.payVia !== 'direct')
			throw new AppError('not_payable', 'Only approved claims paid directly can be marked paid here.', 409);
		await tx
			.update(expenseClaims)
			.set({ status: 'paid', paidAt: new Date(), paidByUserId: m.user.userId })
			.where(eq(expenseClaims.id, c.id));
		return tellClaimant(tx, m, c, `Expense claim paid: ${c.title}`, `৳${taka(c.total)} was paid to you.`);
	});
}

async function withItems<T extends { id: string }>(tx: Tx, claims: T[]) {
	const items = claims.length
		? await tx
				.select({
					id: expenseItems.id,
					claimId: expenseItems.claimId,
					spentOn: expenseItems.spentOn,
					description: expenseItems.description,
					amount: expenseItems.amount,
					receiptName: expenseItems.receiptName,
					category: expenseCategories.name
				})
				.from(expenseItems)
				.innerJoin(expenseCategories, eq(expenseCategories.id, expenseItems.categoryId))
				.where(
					inArray(
						expenseItems.claimId,
						claims.map((c) => c.id)
					)
				)
				.orderBy(asc(expenseItems.spentOn), asc(expenseItems.description))
		: [];
	return claims.map((c) => ({ ...c, items: items.filter((i) => i.claimId === c.id) }));
}

const claimFields = {
	id: expenseClaims.id,
	employeeId: expenseClaims.employeeId,
	title: expenseClaims.title,
	status: expenseClaims.status,
	total: expenseClaims.total,
	payVia: expenseClaims.payVia,
	createdAt: expenseClaims.createdAt,
	name: employees.fullName
};

export async function expenseBoard(tx: Tx, m: Member) {
	const me = m.access.employeeId;
	const [approveScope, payScope] = await Promise.all([
		resolveScope(tx, m.access, 'expense.approve'),
		resolveScope(tx, m.access, 'expense.pay')
	]);
	const lone = await singleAdmin(tx);
	const base = () =>
		tx.select(claimFields).from(expenseClaims).innerJoin(employees, eq(employees.id, expenseClaims.employeeId));
	const mine = me
		? await base().where(eq(expenseClaims.employeeId, me)).orderBy(desc(expenseClaims.createdAt)).limit(50)
		: [];
	const toApprove = await base()
		.where(
			and(
				eq(expenseClaims.status, 'submitted'),
				scopeWhere(approveScope, expenseClaims.employeeId),
				me && !lone ? ne(expenseClaims.employeeId, me) : sql`true`
			)
		)
		.orderBy(asc(expenseClaims.createdAt))
		.limit(200);
	const toPay = await base()
		.where(
			and(
				eq(expenseClaims.status, 'approved'),
				eq(expenseClaims.payVia, 'direct'),
				scopeWhere(payScope, expenseClaims.employeeId)
			)
		)
		.orderBy(asc(expenseClaims.createdAt))
		.limit(200);
	return {
		today: await tenantToday(tx),
		canSubmit: !!me && can(m.access, 'expense.submit'),
		canManage: can(m.access, 'expense.pay'),
		categories: await tx.select().from(expenseCategories).orderBy(asc(expenseCategories.name)),
		mine: await withItems(tx, mine),
		toApprove: await withItems(tx, toApprove),
		toPay: await withItems(tx, toPay)
	};
}

export async function expenseApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	const scope = await resolveScope(tx, access, 'expense.approve');
	const rows = await tx
		.select(claimFields)
		.from(expenseClaims)
		.innerJoin(employees, eq(employees.id, expenseClaims.employeeId))
		.where(
			and(
				eq(expenseClaims.status, 'submitted'),
				scopeWhere(scope, expenseClaims.employeeId),
				access.employeeId ? ne(expenseClaims.employeeId, access.employeeId) : sql`true`
			)
		)
		.orderBy(asc(expenseClaims.createdAt))
		.limit(200);
	return rows.map((r) => ({
		id: r.id,
		kind: 'Expense claim',
		title: `${r.name}: ${r.title} · ৳${taka(r.total)}`,
		requestedBy: r.name,
		at: r.createdAt,
		link: 'expenses'
	}));
}

export async function openReceipt(m: Member, itemId: string) {
	const valid = z.uuid().safeParse(itemId).success;
	const found = await withTenant(userCtx(m), async (tx) => {
		if (!valid) return null;
		const [row] = await tx
			.select({ item: expenseItems, employeeId: expenseClaims.employeeId })
			.from(expenseItems)
			.innerJoin(expenseClaims, eq(expenseClaims.id, expenseItems.claimId))
			.where(eq(expenseItems.id, itemId));
		if (!row?.item.receiptKey) return null;
		const allowed =
			row.employeeId === m.access.employeeId ||
			inScope(await resolveScope(tx, m.access, 'expense.approve'), row.employeeId) ||
			inScope(await resolveScope(tx, m.access, 'expense.pay'), row.employeeId);
		return allowed ? row.item : null;
	});
	if (!found) throw new AppError('not_found', 'That receipt does not exist.', 404);
	return {
		fileName: found.receiptName!,
		contentType: found.receiptType!,
		body: await getObject(found.receiptKey!)
	};
}
