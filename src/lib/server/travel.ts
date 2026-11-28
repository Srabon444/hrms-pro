import { and, asc, desc, eq, inArray, ne, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { money, poishaOf } from '../money';
import { activeMemberships, approvers, deciderWhere, rightsOver, singleAdmin } from './approval-chain';
import type { ApprovalItem } from './approvals';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { departments, employees, expenseClaims, loans, perDiemRates, travelRequests } from './db/schema';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { modulesOn } from './modules';
import { notify } from './notifications';
import { can, userCtx, type Access, type requireMember } from './rbac/access';
import { resolveScope, scopeWhere } from './rbac/scope';
import { tenantCurrency } from './settings';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Trip = typeof travelRequests.$inferSelect;
type Rate = typeof perDiemRates.$inferSelect;

export const TRAVEL = { rows: 200, rates: 500 };

const text = (max: number, empty: string, long: string) =>
	z
		.string()
		.trim()
		.min(1, empty)
		.max(max, long)
		.refine((v) => !/\p{Cc}/u.test(v), 'Remove control characters.');

const place = {
	country: text(60, 'Enter the country.', 'Keep the country under 60 characters.'),
	city: z.union([z.literal(''), text(60, 'Enter the city.', 'Keep the city under 60 characters.')])
};

const day = (message: string) =>
	z.iso.date(message).refine((d) => d >= '2000-01-01' && d <= '2099-12-31', 'Choose a date between 2000 and 2099.');

const amount = (message: string, digits = 7) =>
	z
		.string()
		.trim()
		.regex(new RegExp(`^\\d{1,${digits}}(\\.\\d{1,2})?$`), message)
		.transform(poishaOf);

const tripSchema = z
	.object({
		purpose: text(200, 'Say what the trip is for.', 'Keep the purpose under 200 characters.'),
		...place,
		departOn: day('Enter the departure date.'),
		returnOn: day('Enter the return date.'),
		estimatedCost: amount('Enter the estimated cost, up to 2 decimals.'),
		advance: z.union([z.literal('').transform(() => 0), amount('Enter the advance, up to 2 decimals.')])
	})
	.refine((t) => t.returnOn >= t.departOn, 'The return date cannot be before departure.')
	.refine((t) => t.advance <= t.estimatedCost, 'The advance cannot be more than the estimated cost.');

const rateSchema = z.object({
	...place,
	dailyAmount: amount('Enter a daily amount up to 999999.99.', 6).refine(
		(p) => p > 0,
		'The daily amount must be more than zero.'
	)
});

const decisionSchema = z.object({
	tripId: z.uuid({ error: 'Choose a trip.' }),
	decision: z.enum(['approve', 'reject'], 'Choose approve or reject.'),
	note: z.string().trim().max(300, 'Keep the note under 300 characters.')
});

const tripId = z.object({ tripId: z.uuid({ error: 'Choose a trip.' }) });
const rateId = z.object({ rateId: z.uuid({ error: 'Choose a rate.' }) });

const mustManage = (m: Member) => {
	if (!can(m.access, 'travel.manage')) throw new AppError('forbidden', 'You cannot change per diem rates.', 403);
};

const notFound = () => new AppError('not_found', 'That trip does not exist.', 404);

export const tripDays = (t: Pick<Trip, 'departOn' | 'returnOn'>) =>
	Math.round((Date.parse(t.returnOn) - Date.parse(t.departOn)) / 86_400_000) + 1;

const key = (v: string | null) => (v ?? '').trim().toLowerCase();

export function perDiemFor(
	rates: Pick<Rate, 'country' | 'city' | 'dailyAmount'>[],
	t: Pick<Trip, 'country' | 'city' | 'departOn' | 'returnOn'>
) {
	const inCountry = rates.filter((r) => key(r.country) === key(t.country));
	const rate =
		(t.city ? inCountry.find((r) => r.city && key(r.city) === key(t.city)) : undefined) ??
		inCountry.find((r) => !r.city);
	if (!rate) return null;
	const days = tripDays(t);
	return { daily: rate.dailyAmount, days, total: rate.dailyAmount * days, city: !!rate.city };
}

const loadTrip = async (tx: Tx, id: string) =>
	(await tx.select().from(travelRequests).where(eq(travelRequests.id, id)).for('update'))[0];

const loadEmployee = async (tx: Tx, id: string) => (await tx.select().from(employees).where(eq(employees.id, id)))[0];

export async function requestTrip(m: Member, form: Record<string, string>) {
	const input = tripSchema.parse(form);
	const employeeId = m.access.employeeId;
	if (!employeeId) throw new AppError('no_employee', 'Only employees can ask for a trip.', 409);
	return withTenant(userCtx(m), async (tx) => {
		const e = await loadEmployee(tx, employeeId);
		if (!e || e.status === 'exited') throw new AppError('exited', 'People who have left cannot ask for a trip.', 409);
		if (input.departOn < (await tenantToday(tx)))
			throw new AppError('past_trip', 'The trip cannot start in the past.', 400);
		await tx.insert(travelRequests).values({
			tenantId: m.tenant.id,
			employeeId,
			...input,
			city: input.city || null,
			requestedByUserId: m.user.userId
		});
		return notify(
			tx,
			m.tenant.id,
			await approvers(tx, e, 'travel'),
			{
				category: 'approvals',
				title: 'Trip waiting for approval',
				body: `${e.fullName}: ${input.purpose}, ${input.departOn} to ${input.returnOn}.`,
				link: 'travel'
			},
			m.tenant.slug
		);
	});
}

export async function cancelTrip(m: Member, form: Record<string, string>) {
	const input = tripId.parse(form);
	await withTenant(userCtx(m), async (tx) => {
		const t = await loadTrip(tx, input.tripId);
		const e = t && (await loadEmployee(tx, t.employeeId));
		if (!t || !e) throw notFound();
		const rights = await rightsOver(tx, m.access, e, 'travel');
		if (!rights.canCancel)
			throw rights.canView ? new AppError('forbidden', 'You cannot cancel this trip.', 403) : notFound();
		if (t.status !== 'submitted') throw new AppError('decided', 'Only a trip still waiting can be cancelled.', 409);
		await tx.update(travelRequests).set({ status: 'cancelled' }).where(eq(travelRequests.id, t.id));
	});
}

async function createAdvance(tx: Tx, m: Member, t: Trip) {
	const [waiting] = await tx
		.select({ id: loans.id })
		.from(loans)
		.where(and(eq(loans.employeeId, t.employeeId), eq(loans.status, 'requested')));
	const busy = () =>
		new AppError(
			'advance_waiting',
			'This person already has a loan or advance waiting for a decision. Ask finance to decide it first.',
			409
		);
	if (waiting) throw busy();
	const thisMonth = (await tenantToday(tx)).slice(0, 7);
	const back = t.returnOn.slice(0, 7);
	const [loan] = await tx
		.insert(loans)
		.values({
			tenantId: m.tenant.id,
			employeeId: t.employeeId,
			kind: 'advance',
			amount: t.advance,
			instalments: 1,
			startPeriod: back < thisMonth ? thisMonth : back,
			reason: `Travel advance: ${t.purpose}`,
			requestedByUserId: t.requestedByUserId
		})
		.returning({ id: loans.id })
		.catch((err) => {
			if (pgCode(err) === UNIQUE_VIOLATION) throw busy();
			throw err;
		});
	return loan.id;
}

export async function decideTrip(m: Member, form: Record<string, string>) {
	const input = decisionSchema.parse(form);
	return withTenant(userCtx(m), async (tx) => {
		const t = await loadTrip(tx, input.tripId);
		const e = t && (await loadEmployee(tx, t.employeeId));
		if (!t || !e) throw notFound();
		const rights = await rightsOver(tx, m.access, e, 'travel');
		if (!rights.canDecide) {
			if (!rights.canView) throw notFound();
			throw rights.own
				? new AppError('own_trip', 'Someone else must decide your own trip.', 403)
				: new AppError('forbidden', 'You cannot decide this trip.', 403);
		}
		if (t.status !== 'submitted') throw new AppError('decided', 'That trip is already decided.', 409);
		const approved = input.decision === 'approve';
		if (approved && e.status === 'exited')
			throw new AppError('exited', 'This person has left, so the trip cannot be approved. Reject it instead.', 409);
		const loanId = approved && t.advance > 0 ? await createAdvance(tx, m, t) : null;
		await tx
			.update(travelRequests)
			.set({
				status: approved ? 'approved' : 'rejected',
				decidedByUserId: m.user.userId,
				decidedAt: new Date(),
				decisionNote: input.note || null,
				loanId
			})
			.where(eq(travelRequests.id, t.id));
		const currency = await tenantCurrency(tx);
		return notify(
			tx,
			m.tenant.id,
			await activeMemberships(tx, t.employeeId),
			{
				category: 'approvals',
				title: `Trip ${approved ? 'approved' : 'rejected'}: ${t.purpose}`,
				body: approved
					? loanId
						? `Your advance of ${money(t.advance, currency)} is now with finance for approval.`
						: undefined
					: input.note || undefined,
				link: 'travel'
			},
			m.tenant.slug
		);
	});
}

export async function saveRate(m: Member, form: Record<string, string>) {
	const input = rateSchema.parse(form);
	mustManage(m);
	await withTenant(userCtx(m), async (tx) => {
		const count = (await tx.select({ n: sql<number>`count(*)::int` }).from(perDiemRates))[0].n;
		if (count >= TRAVEL.rates) throw new AppError('too_many', `Keep at most ${TRAVEL.rates} per diem rates.`, 409);
		await tx
			.insert(perDiemRates)
			.values({ tenantId: m.tenant.id, ...input, city: input.city || null })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('rate_exists', 'That place already has a rate. Remove it first to change it.', 409);
				throw err;
			});
	});
}

export async function deleteRate(m: Member, form: Record<string, string>) {
	const input = rateId.parse(form);
	mustManage(m);
	await withTenant(userCtx(m), async (tx) => {
		const gone = await tx
			.delete(perDiemRates)
			.where(eq(perDiemRates.id, input.rateId))
			.returning({ id: perDiemRates.id });
		if (!gone.length) throw new AppError('not_found', 'That rate does not exist.', 404);
	});
}

const tripFields = {
	id: travelRequests.id,
	employeeId: travelRequests.employeeId,
	purpose: travelRequests.purpose,
	country: travelRequests.country,
	city: travelRequests.city,
	departOn: travelRequests.departOn,
	returnOn: travelRequests.returnOn,
	estimatedCost: travelRequests.estimatedCost,
	advance: travelRequests.advance,
	status: travelRequests.status,
	decisionNote: travelRequests.decisionNote,
	loanId: travelRequests.loanId,
	createdAt: travelRequests.createdAt,
	name: employees.fullName
};

const SETTLED_OUT = ['rejected', 'cancelled'];

async function withMoney<
	T extends Pick<Trip, 'id' | 'loanId' | 'advance' | 'country' | 'city' | 'departOn' | 'returnOn'>
>(tx: Tx, rows: T[], rates: Rate[]) {
	const ids = rows.map((r) => r.id);
	const loanIds = rows.flatMap((r) => (r.loanId ? [r.loanId] : []));
	const [claims, advances] = await Promise.all([
		ids.length
			? tx
					.select({ tripId: expenseClaims.travelRequestId, total: sql<string>`sum(${expenseClaims.total})` })
					.from(expenseClaims)
					.where(and(inArray(expenseClaims.travelRequestId, ids), notInArray(expenseClaims.status, SETTLED_OUT)))
					.groupBy(expenseClaims.travelRequestId)
			: [],
		loanIds.length
			? tx.select({ id: loans.id, status: loans.status }).from(loans).where(inArray(loans.id, loanIds))
			: []
	]);
	return rows.map((r) => {
		const claimed = Number(claims.find((c) => c.tripId === r.id)?.total ?? 0);
		const advanceStatus = advances.find((a) => a.id === r.loanId)?.status ?? null;
		const advanced = advanceStatus && !SETTLED_OUT.includes(advanceStatus) ? r.advance : 0;
		return {
			...r,
			days: tripDays(r),
			perDiem: perDiemFor(rates, r),
			claimed,
			advanceStatus,
			settlement: claimed - advanced
		};
	});
}

export async function travelBoard(tx: Tx, m: Member) {
	const me = m.access.employeeId;
	const lone = await singleAdmin(tx);
	const [decide, read, manage] = await Promise.all([
		deciderWhere(tx, m.access, 'travel'),
		resolveScope(tx, m.access, 'travel.read'),
		resolveScope(tx, m.access, 'travel.manage')
	]);
	const rates = await tx
		.select()
		.from(perDiemRates)
		.orderBy(sql`lower(${perDiemRates.country})`, sql`lower(${perDiemRates.city}) nulls first`)
		.limit(TRAVEL.rates);
	const base = () =>
		tx
			.select(tripFields)
			.from(travelRequests)
			.innerJoin(employees, eq(employees.id, travelRequests.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId));
	const mine = me
		? await base().where(eq(travelRequests.employeeId, me)).orderBy(desc(travelRequests.departOn)).limit(50)
		: [];
	const toDecide = await base()
		.where(
			and(eq(travelRequests.status, 'submitted'), decide, me && !lone ? ne(travelRequests.employeeId, me) : sql`true`)
		)
		.orderBy(asc(travelRequests.createdAt))
		.limit(TRAVEL.rows);
	const others = await base()
		.where(
			and(
				ne(travelRequests.status, 'submitted'),
				or(scopeWhere(read, travelRequests.employeeId), scopeWhere(manage, travelRequests.employeeId)),
				me ? ne(travelRequests.employeeId, me) : sql`true`
			)
		)
		.orderBy(desc(travelRequests.departOn))
		.limit(TRAVEL.rows);
	return {
		today: await tenantToday(tx),
		canRequest: !!me && can(m.access, 'travel.request'),
		canManage: can(m.access, 'travel.manage'),
		rates,
		mine: await withMoney(tx, mine, rates),
		toDecide: await withMoney(tx, toDecide, rates),
		others: await withMoney(tx, others, rates)
	};
}

export async function claimableTrips(tx: Tx, employeeId: string, onlyId?: string) {
	if (!(await modulesOn(tx)).has('travel')) return [];
	const rows = await tx
		.select()
		.from(travelRequests)
		.where(
			and(
				eq(travelRequests.employeeId, employeeId),
				eq(travelRequests.status, 'approved'),
				onlyId ? eq(travelRequests.id, onlyId) : undefined
			)
		)
		.orderBy(desc(travelRequests.departOn))
		.limit(50);
	const rates = rows.length ? await tx.select().from(perDiemRates).limit(TRAVEL.rates) : [];
	return rows.map((t) => ({
		id: t.id,
		purpose: t.purpose,
		departOn: t.departOn,
		returnOn: t.returnOn,
		advance: t.advance,
		perDiem: perDiemFor(rates, t)
	}));
}

export async function travelApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	if (!(await modulesOn(tx)).has('travel')) return [];
	const me = access.employeeId;
	const where = await deciderWhere(tx, access, 'travel');
	const rows = await tx
		.select({
			id: travelRequests.id,
			at: travelRequests.createdAt,
			name: employees.fullName,
			employeeId: employees.id,
			purpose: travelRequests.purpose,
			departOn: travelRequests.departOn
		})
		.from(travelRequests)
		.innerJoin(employees, eq(employees.id, travelRequests.employeeId))
		.leftJoin(departments, eq(departments.id, employees.departmentId))
		.where(and(eq(travelRequests.status, 'submitted'), where))
		.orderBy(asc(travelRequests.createdAt))
		.limit(TRAVEL.rows);
	const single = rows.some((r) => r.employeeId === me) && (await singleAdmin(tx));
	return rows
		.filter((r) => r.employeeId !== me || single)
		.map((r) => ({
			id: r.id,
			kind: 'Trip',
			title: `${r.name}: ${r.purpose}, from ${r.departOn}`,
			requestedBy: r.name,
			at: r.at,
			link: 'travel'
		}));
}
