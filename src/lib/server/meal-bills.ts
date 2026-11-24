import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { mealCharge, money, poishaOf } from '../money';
import { now } from './clock';
import { authPool } from './db';
import { addDays } from './dates';
import {
	employees,
	MEAL_PAYMENT_METHODS,
	mealBillLines,
	mealBills,
	mealDays,
	mealOrders,
	mealPayments,
	mealTypes,
	mealVendors,
	tenants,
	tenantSettings
} from './db/schema';
import { AppError } from './errors';
import { advisoryLock, LOCK } from './locks';
import { log } from './log';
import { sendMail } from './mail';
import { renderBillPdf } from './meal-bill-pdf';
import { tenantToday } from './lifecycle';
import { unlockedDays } from './meal-orders';
import { can, userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { putObject } from './storage';
import { systemCtx, withTenant, type Tx } from './tenancy';
import { tenantCurrency } from './settings';
import { queue } from './queue';

type Member = ReturnType<typeof requireMember>;

const SETTLED = ['issued', 'partially_paid', 'paid', 'deducted'];

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month.');
const periodInput = z.object({ period: periodSchema });

export const periodRange = (period: string) => {
	const from = `${period}-01`;
	const [y, m] = period.split('-').map(Number);
	return { from, to: addDays(`${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}-01`, -1) };
};

export const lastPeriod = (today: string) => addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);

async function billingScope(tx: Tx, access: Access) {
	const scope = await resolveScope(tx, access, 'meal.billing');
	if (scope.kind !== 'all') throw new AppError('forbidden', 'Only meal billing for everyone can do this.', 403);
}

const charge = (o: { status: string; guestQty: number; unitCost: number; subsidyPct: number }) =>
	mealCharge(o.status === 'ordered', o.guestQty, o.unitCost, o.subsidyPct);

async function draftBills(tx: Tx, tenantId: string, period: string) {
	const { from, to } = periodRange(period);
	const open = await unlockedDays(tx, from, to);
	if (open.length)
		throw new AppError(
			'unlocked_days',
			`Lock these days first: ${open.slice(0, 5).join(', ')}${open.length > 5 ? ' and more' : ''}.`,
			409
		);
	const frozen = new Set(
		(
			await tx
				.select({ employeeId: mealBills.employeeId })
				.from(mealBills)
				.where(and(eq(mealBills.period, period), inArray(mealBills.status, SETTLED)))
		).map((b) => b.employeeId)
	);
	await tx.delete(mealBills).where(and(eq(mealBills.period, period), eq(mealBills.status, 'draft')));
	const fields = {
		orderId: mealOrders.id,
		employeeId: mealOrders.employeeId,
		date: mealOrders.date,
		meal: mealTypes.name,
		status: mealOrders.status,
		guestQty: mealOrders.guestQty,
		unitCost: sql<number>`${mealOrders.unitCost}`,
		subsidyPct: sql<number>`${mealOrders.subsidyPct}`
	};
	const current = await tx
		.select(fields)
		.from(mealOrders)
		.innerJoin(mealTypes, eq(mealTypes.id, mealOrders.mealTypeId))
		.where(and(gte(mealOrders.date, from), lte(mealOrders.date, to), isNotNull(mealOrders.unitCost)));
	const earlier = await tx
		.select(fields)
		.from(mealOrders)
		.innerJoin(mealTypes, eq(mealTypes.id, mealOrders.mealTypeId))
		.innerJoin(
			mealBills,
			and(
				eq(mealBills.employeeId, mealOrders.employeeId),
				eq(mealBills.period, sql`to_char(${mealOrders.date}, 'YYYY-MM')`),
				inArray(mealBills.status, SETTLED)
			)
		)
		.innerJoin(mealDays, and(eq(mealDays.date, mealOrders.date), gt(mealDays.lockedAt, mealBills.issuedAt)))
		.where(isNotNull(mealOrders.unitCost));
	const billed = new Map(
		(
			await tx
				.select({ orderId: mealBillLines.orderId, amount: sql<number>`sum(${mealBillLines.amount})::int` })
				.from(mealBillLines)
				.innerJoin(mealBills, eq(mealBills.id, mealBillLines.billId))
				.where(
					and(
						inArray(mealBills.status, SETTLED),
						inArray(
							mealBillLines.orderId,
							earlier.map((o) => o.orderId)
						)
					)
				)
				.groupBy(mealBillLines.orderId)
		).map((b) => [b.orderId, b.amount])
	);
	const line = (o: (typeof current)[number], kind: string, amount: number) => ({
		tenantId,
		orderId: o.orderId,
		employeeId: o.employeeId,
		kind,
		date: o.date,
		meal: o.meal,
		plates: o.status === 'ordered' ? 1 : 0,
		guests: o.guestQty,
		unitCost: o.unitCost,
		subsidyPct: o.subsidyPct,
		amount
	});
	const lines = [
		...current.map((o) => line(o, 'meal', charge(o))).filter((l) => l.amount > 0),
		...earlier.map((o) => line(o, 'adjustment', charge(o) - (billed.get(o.orderId) ?? 0))).filter((l) => l.amount)
	]
		.filter((l) => !frozen.has(l.employeeId))
		.sort((a, b) => a.date.localeCompare(b.date) || a.meal.localeCompare(b.meal) || a.kind.localeCompare(b.kind));
	const people = [...new Set(lines.map((l) => l.employeeId))];
	if (!people.length) return 0;
	const [s] = await tx.select({ mode: tenantSettings.mealBillingMode }).from(tenantSettings);
	const left = new Set(
		(
			await tx
				.select({ id: employees.id })
				.from(employees)
				.where(and(inArray(employees.id, people), eq(employees.status, 'exited')))
		).map((e) => e.id)
	);
	const bills = await tx
		.insert(mealBills)
		.values(
			people.map((employeeId) => ({
				tenantId,
				employeeId,
				period,
				billingMode: left.has(employeeId) ? 'direct' : s.mode,
				total: lines.filter((l) => l.employeeId === employeeId).reduce((n, l) => n + l.amount, 0)
			}))
		)
		.returning({ id: mealBills.id, employeeId: mealBills.employeeId });
	const billOf = new Map(bills.map((b) => [b.employeeId, b.id]));
	await tx
		.insert(mealBillLines)
		.values(lines.map(({ employeeId, ...l }) => ({ ...l, billId: billOf.get(employeeId)! })));
	return bills.length;
}

export async function generateBills(m: Member, raw: Record<string, string>) {
	const { period } = periodInput.parse(raw);
	return withTenant(userCtx(m), async (tx) => {
		await billingScope(tx, m.access);
		await advisoryLock(tx, LOCK.mealBilling, m.tenant.id);
		return draftBills(tx, m.tenant.id, period);
	});
}

export type BillJob = { tenantId: string; billId: string };

const enqueueBills = (tenantId: string, ids: string[], attempt = '') =>
	Promise.all(
		ids.map((billId) =>
			queue('meal-bills').add('send', { tenantId, billId }, { jobId: `meal-bill-${billId}${attempt}` })
		)
	).catch((err) => log.warn({ tenantId, err: (err as Error).message }, 'meal bill jobs not queued'));

export async function issueBills(m: Member, raw: Record<string, string>) {
	const { period } = periodInput.parse(raw);
	const ids = await withTenant(userCtx(m), async (tx) => {
		await billingScope(tx, m.access);
		await advisoryLock(tx, LOCK.mealBilling, m.tenant.id);
		await draftBills(tx, m.tenant.id, period);
		const issued = await tx
			.update(mealBills)
			.set({ status: 'issued', issuedAt: now(), issuedByUserId: m.user.userId })
			.where(and(eq(mealBills.period, period), eq(mealBills.status, 'draft')))
			.returning({ id: mealBills.id });
		return issued.map((b) => b.id);
	});
	await enqueueBills(m.tenant.id, ids);
	return ids.length;
}

async function unclaimedBill(tx: Tx, m: Member, billId: string) {
	await advisoryLock(tx, LOCK.payroll, m.tenant.id);
	await advisoryLock(tx, LOCK.mealBilling, m.tenant.id);
	const [bill] = await tx.select().from(mealBills).where(eq(mealBills.id, billId));
	if (!bill || !inScope(await resolveScope(tx, m.access, 'meal.billing'), bill.employeeId))
		throw new AppError('not_found', 'That bill does not exist.', 404);
	if (bill.payrollRunId)
		throw new AppError('claimed', 'An approved payroll run already deducts this bill. Reopen that run first.', 409);
	return bill;
}

const billInput = z.object({ billId: z.uuid({ error: 'Choose a bill.' }) });

export async function voidBill(m: Member, raw: Record<string, string>) {
	const { billId } = billInput.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const bill = await unclaimedBill(tx, m, billId);
		if (bill.status !== 'issued' || bill.paid)
			throw new AppError('not_voidable', 'Only an issued bill with no payment can be voided.', 409);
		await tx.update(mealBills).set({ status: 'void' }).where(eq(mealBills.id, bill.id));
	});
}

export async function periodBills(tx: Tx, access: Access, raw: string) {
	const period = periodSchema.parse(raw);
	const scope = await resolveScope(tx, access, 'meal.billing');
	const { from, to } = periodRange(period);
	const bills = await tx
		.select({
			id: mealBills.id,
			name: employees.fullName,
			code: employees.code,
			status: mealBills.status,
			billingMode: mealBills.billingMode,
			total: mealBills.total,
			paid: mealBills.paid
		})
		.from(mealBills)
		.innerJoin(employees, eq(employees.id, mealBills.employeeId))
		.where(and(eq(mealBills.period, period), scopeWhere(scope, mealBills.employeeId)))
		.orderBy(asc(employees.fullName), desc(mealBills.createdAt));
	return {
		period,
		canRun: scope.kind === 'all',
		unlocked: await unlockedDays(tx, from, to),
		bills
	};
}

export async function myBills(tx: Tx, access: Access) {
	if (!access.employeeId) return [];
	const bills = await tx
		.select({
			id: mealBills.id,
			period: mealBills.period,
			status: mealBills.status,
			billingMode: mealBills.billingMode,
			total: mealBills.total,
			paid: mealBills.paid
		})
		.from(mealBills)
		.where(and(eq(mealBills.employeeId, access.employeeId), ne(mealBills.status, 'draft')))
		.orderBy(desc(mealBills.period), desc(mealBills.createdAt))
		.limit(24);
	const lines = bills.length
		? await tx
				.select()
				.from(mealBillLines)
				.where(
					inArray(
						mealBillLines.billId,
						bills.map((b) => b.id)
					)
				)
				.orderBy(asc(mealBillLines.date), asc(mealBillLines.meal), asc(mealBillLines.kind))
		: [];
	return bills.map((b) => ({ ...b, lines: lines.filter((l) => l.billId === b.id) }));
}

export async function mealDue(tx: Tx, access: Access) {
	if (!access.employeeId) return 0;
	const [due] = await tx
		.select({ amount: sql<number>`coalesce(sum(${mealBills.total} - ${mealBills.paid}), 0)::int` })
		.from(mealBills)
		.where(
			and(
				eq(mealBills.employeeId, access.employeeId),
				eq(mealBills.billingMode, 'direct'),
				inArray(mealBills.status, ['issued', 'partially_paid'])
			)
		);
	return due.amount;
}

const paymentInput = z.object({
	billId: z.uuid({ error: 'Choose a bill.' }),
	amount: z
		.string()
		.trim()
		.regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter the amount, up to 2 decimals.')
		.transform(poishaOf)
		.refine((p) => p >= 1, 'The amount must be more than zero.'),
	paidOn: z.iso.date('Enter the payment date.'),
	method: z.enum(MEAL_PAYMENT_METHODS, 'Choose how it was paid.'),
	note: z
		.string()
		.trim()
		.max(200, 'Keep the note under 200 characters.')
		.transform((v) => v || null)
});

export async function recordPayment(m: Member, raw: Record<string, string>) {
	const input = paymentInput.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const bill = await unclaimedBill(tx, m, input.billId);
		if (bill.billingMode !== 'direct' || !['issued', 'partially_paid'].includes(bill.status))
			throw new AppError('not_payable', 'Only an issued bill paid in cash can take a payment.', 409);
		if (input.amount > bill.total - bill.paid)
			throw new AppError(
				'overpaid',
				`Only ${money(bill.total - bill.paid, await tenantCurrency(tx))} is due on this bill.`,
				409
			);
		if (input.paidOn > (await tenantToday(tx)))
			throw new AppError('future_payment', 'The payment date cannot be in the future.', 400);
		await tx.insert(mealPayments).values({ tenantId: m.tenant.id, ...input, recordedByUserId: m.user.userId });
		const paid = bill.paid + input.amount;
		await tx
			.update(mealBills)
			.set({ paid, status: paid === bill.total ? 'paid' : 'partially_paid' })
			.where(eq(mealBills.id, bill.id));
	});
}

export async function mealStatement(tx: Tx, raw: string) {
	const { from, to } = periodRange(periodSchema.parse(raw));
	const groups = await tx
		.select({
			vendor: mealVendors.name,
			meal: mealTypes.name,
			unitCost: sql<number>`${mealOrders.unitCost}`,
			subsidyPct: sql<number>`${mealOrders.subsidyPct}`,
			plates: sql<number>`(count(*) filter (where ${mealOrders.status} = 'ordered'))::int`,
			guests: sql<number>`sum(${mealOrders.guestQty})::int`
		})
		.from(mealOrders)
		.innerJoin(mealTypes, eq(mealTypes.id, mealOrders.mealTypeId))
		.innerJoin(mealVendors, eq(mealVendors.id, mealTypes.vendorId))
		.where(and(gte(mealOrders.date, from), lte(mealOrders.date, to), isNotNull(mealOrders.unitCost)))
		.groupBy(mealVendors.name, mealTypes.name, mealOrders.unitCost, mealOrders.subsidyPct)
		.orderBy(asc(mealVendors.name), asc(mealTypes.name), asc(mealOrders.unitCost));
	const rows = groups.map((g) => {
		const cost = (g.plates + g.guests) * g.unitCost;
		const staff = g.plates * mealCharge(true, 0, g.unitCost, g.subsidyPct) + g.guests * g.unitCost;
		return { ...g, cost, staff, company: cost - staff };
	});
	const sum = (k: 'cost' | 'staff' | 'company') => rows.reduce((n, r) => n + r[k], 0);
	return { rows, cost: sum('cost'), staff: sum('staff'), company: sum('company') };
}

export async function billDocument(tx: Tx, billId: string) {
	const [bill] = await tx
		.select({
			id: mealBills.id,
			tenantId: mealBills.tenantId,
			employeeId: mealBills.employeeId,
			period: mealBills.period,
			status: mealBills.status,
			billingMode: mealBills.billingMode,
			total: mealBills.total,
			paid: mealBills.paid,
			employee: employees.fullName,
			code: employees.code,
			workEmail: employees.workEmail,
			personalEmail: employees.personalEmail,
			legalName: sql<string | null>`(select ${tenantSettings.legalName} from ${tenantSettings})`,
			currency: sql<string>`(select ${tenantSettings.currency} from ${tenantSettings})`
		})
		.from(mealBills)
		.innerJoin(employees, eq(employees.id, mealBills.employeeId))
		.where(and(eq(mealBills.id, billId), inArray(mealBills.status, SETTLED)));
	if (!bill) return null;
	const lines = await tx
		.select()
		.from(mealBillLines)
		.where(eq(mealBillLines.billId, bill.id))
		.orderBy(asc(mealBillLines.date), asc(mealBillLines.meal), asc(mealBillLines.kind));
	const [tenant] = await authPool()
		.db.select({ name: tenants.name })
		.from(tenants)
		.where(eq(tenants.id, bill.tenantId));
	return { ...bill, company: bill.legalName ?? tenant.name, lines };
}

export async function sendMealBill({ tenantId, billId }: BillJob) {
	const ctx = systemCtx(tenantId);
	const doc = await withTenant(ctx, (tx) => billDocument(tx, billId));
	if (!doc) return;
	const key = `t/${tenantId}/meal-bills/${billId}.pdf`;
	await putObject(key, await renderBillPdf(doc), 'application/pdf');
	const rows = await withTenant(ctx, (tx) =>
		tx.execute<{ email: string }>(
			sql`select email from tenant_users where employee_id = ${doc.employeeId} and membership_status = 'active' limit 1`
		)
	);
	const to = rows[0]?.email ?? doc.workEmail ?? doc.personalEmail;
	if (to)
		await sendMail(
			{
				to,
				subject: `Meal bill for ${doc.period}`,
				text: [
					`Hello ${doc.employee},`,
					'',
					`Your meal bill for ${doc.period} from ${doc.company} is attached.`,
					`Total: ${money(doc.total, doc.currency)}.`,
					doc.billingMode === 'payroll'
						? 'It will be deducted from your salary.'
						: 'Please pay it directly to the meal manager.'
				].join('\n'),
				attachments: [{ filename: `meal-bill-${doc.period}.pdf`, key, contentType: 'application/pdf' }]
			},
			`meal-bill-mail-${billId}`
		);
	else log.warn({ tenantId, billId }, 'meal bill has no recipient');
	await withTenant(ctx, (tx) => tx.update(mealBills).set({ pdfKey: key }).where(eq(mealBills.id, billId)));
}

export async function sweepMealBills() {
	const list = await authPool().db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
	for (const t of list) {
		const stuck = await withTenant(systemCtx(t.id), (tx) =>
			tx
				.select({ id: mealBills.id })
				.from(mealBills)
				.where(
					and(
						inArray(mealBills.status, SETTLED),
						isNull(mealBills.pdfKey),
						lt(mealBills.issuedAt, new Date(now().getTime() - 3_600_000))
					)
				)
		);
		await enqueueBills(
			t.id,
			stuck.map((b) => b.id),
			`-retry-${Math.floor(now().getTime() / 3_600_000)}`
		);
	}
}

export async function openBillPdf(m: Member, billId: string) {
	const valid = billInput.safeParse({ billId }).success;
	return withTenant(userCtx(m), async (tx) => {
		const doc = valid ? await billDocument(tx, billId) : null;
		const own = doc?.employeeId === m.access.employeeId && can(m.access, 'meal.order');
		const managed =
			doc && can(m.access, 'meal.billing') && inScope(await resolveScope(tx, m.access, 'meal.billing'), doc.employeeId);
		if (!doc || !(own || managed)) throw new AppError('not_found', 'That bill does not exist.', 404);
		return { fileName: `meal-bill-${doc.period}.pdf`, body: await renderBillPdf(doc) };
	});
}
