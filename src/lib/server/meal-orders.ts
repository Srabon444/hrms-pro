import { and, asc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zonedInstant } from './attendance-day';
import { auditEvent } from './audit';
import { now } from './clock';
import { addDays, dateIn } from './dates';
import { authPool } from './db';
import {
	employees,
	holidays,
	leaveRequestDays,
	mealDays,
	mealOrders,
	mealTypePrices,
	mealTypes,
	tenants,
	tenantSettings
} from './db/schema';
import { AppError } from './errors';
import { log } from './log';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Status = 'ordered' | 'opted_out' | 'auto_off';
type Rules = Awaited<ReturnType<typeof rules>>;

export const MEAL_DAYS_AHEAD = 14;
const MAX_AHEAD = 60;
const MAX_RANGE = 62;

async function rules(tx: Tx) {
	const [s] = await tx
		.select({
			timeZone: tenantSettings.timezone,
			weekendDays: tenantSettings.weekendDays,
			cutoff: tenantSettings.mealCutoffTime,
			mode: tenantSettings.mealMode,
			workingDaysOnly: tenantSettings.mealWorkingDaysOnly
		})
		.from(tenantSettings);
	return { ...s, today: dateIn(now(), s.timeZone) };
}

const cutoffAt = (r: Rules, date: string) => zonedInstant(`${date}T${r.cutoff.slice(0, 5)}`, r.timeZone);
const isOpen = (r: Rules, date: string) => now() < cutoffAt(r, date);
const weekend = (r: Rules, date: string) => r.weekendDays.includes(new Date(`${date}T00:00:00Z`).getUTCDay());

const datesBetween = (from: string, to: string) => {
	const out: string[] = [];
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
};

function defaultStatus(r: Rules, working: boolean, onLeave: boolean): Status | null {
	if (!working && r.workingDaysOnly) return null;
	if (!working || onLeave) return 'auto_off';
	return r.mode === 'opt_out' ? 'ordered' : 'opted_out';
}

async function menu(tx: Tx, to: string) {
	const types = await tx
		.select({ id: mealTypes.id, name: mealTypes.name })
		.from(mealTypes)
		.where(eq(mealTypes.active, true))
		.orderBy(asc(mealTypes.name));
	const prices = await tx
		.select()
		.from(mealTypePrices)
		.where(lte(mealTypePrices.effectiveFrom, to))
		.orderBy(sql`${mealTypePrices.effectiveFrom} desc`);
	return (date: string) =>
		types.flatMap((t) => {
			const p = prices.find((x) => x.mealTypeId === t.id && x.effectiveFrom <= date);
			return p ? [{ ...t, unitCost: p.unitCost, subsidyPct: p.subsidyPct }] : [];
		});
}

async function holidaySet(tx: Tx, from: string, to: string) {
	const rows = await tx
		.select({ date: holidays.date })
		.from(holidays)
		.where(and(gte(holidays.date, from), lte(holidays.date, to)));
	return new Set(rows.map((h) => h.date));
}

async function leaveSet(tx: Tx, from: string, to: string, employeeIds: string[]) {
	if (!employeeIds.length) return new Set<string>();
	const rows = await tx
		.select({ employeeId: leaveRequestDays.employeeId, date: leaveRequestDays.date })
		.from(leaveRequestDays)
		.where(
			and(
				inArray(leaveRequestDays.employeeId, employeeIds),
				eq(leaveRequestDays.status, 'approved'),
				eq(leaveRequestDays.session, 'full'),
				gte(leaveRequestDays.date, from),
				lte(leaveRequestDays.date, to)
			)
		);
	return new Set(rows.map((l) => `${l.employeeId}:${l.date}`));
}

async function preparedSet(tx: Tx, from: string, to: string) {
	const rows = await tx
		.select({ date: mealDays.date })
		.from(mealDays)
		.where(and(gte(mealDays.date, from), lte(mealDays.date, to)));
	return new Set(rows.map((d) => d.date));
}

const employedOn = (e: { joinDate: string; exitDate: string | null }, date: string) =>
	date >= e.joinDate && (!e.exitDate || date <= e.exitDate);

async function self(tx: Tx, access: Access) {
	if (!access.employeeId) throw new AppError('no_employee', 'Your account is not linked to an employee.', 403);
	const [e] = await tx
		.select({ id: employees.id, joinDate: employees.joinDate, exitDate: employees.exitDate })
		.from(employees)
		.where(eq(employees.id, access.employeeId));
	return e;
}

export async function myMeals(tx: Tx, access: Access) {
	if (!access.employeeId) return null;
	const e = await self(tx, access);
	const r = await rules(tx);
	const to = addDays(r.today, MEAL_DAYS_AHEAD - 1);
	const served = await menu(tx, to);
	const off = await holidaySet(tx, r.today, to);
	const leave = await leaveSet(tx, r.today, to, [e.id]);
	const prepared = await preparedSet(tx, r.today, to);
	const orders = await tx
		.select()
		.from(mealOrders)
		.where(and(eq(mealOrders.employeeId, e.id), gte(mealOrders.date, r.today), lte(mealOrders.date, to)));
	return {
		cutoff: r.cutoff.slice(0, 5),
		today: r.today,
		days: datesBetween(r.today, to)
			.filter((date) => employedOn(e, date))
			.map((date) => {
				const working = !weekend(r, date) && !off.has(date);
				const fallback = defaultStatus(r, working, leave.has(`${e.id}:${date}`));
				const open = isOpen(r, date) && !prepared.has(date);
				return {
					date,
					working,
					open,
					meals:
						!working && r.workingDaysOnly
							? []
							: served(date).map((t) => {
									const o = orders.find((x) => x.date === date && x.mealTypeId === t.id);
									return {
										mealTypeId: t.id,
										name: t.name,
										unitCost: t.unitCost,
										subsidyPct: t.subsidyPct,
										status: (o?.status ?? fallback) as Status,
										guestQty: o?.guestQty ?? 0
									};
								})
				};
			})
	};
}

const choiceSchema = z.object({
	date: z.iso.date('Choose a day.'),
	mealTypeId: z.uuid({ error: 'Choose a meal.' }),
	status: z.enum(['ordered', 'opted_out'], 'Choose whether you eat.'),
	guestQty: z.coerce
		.number('Guests must be 0 to 10.')
		.int('Guests must be 0 to 10.')
		.min(0, 'Guests must be 0 to 10.')
		.max(10, 'Guests must be 0 to 10.')
});

async function servable(tx: Tx, r: Rules, date: string) {
	if (date > addDays(r.today, MAX_AHEAD))
		throw new AppError('too_far', `Meals can be chosen up to ${MAX_AHEAD} days ahead.`, 400);
	if (!isOpen(r, date) || (await preparedSet(tx, date, date)).size)
		throw new AppError('closed', `Changes for ${date} closed at ${r.cutoff.slice(0, 5)}.`, 409);
	const working = !weekend(r, date) && !(await holidaySet(tx, date, date)).size;
	return { working, served: !working && r.workingDaysOnly ? [] : (await menu(tx, date))(date) };
}

export async function chooseMeal(m: Member, raw: Record<string, string>) {
	const input = choiceSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const e = await self(tx, m.access);
		const r = await rules(tx);
		const { served } = await servable(tx, r, input.date);
		if (!employedOn(e, input.date)) throw new AppError('not_employed', 'You are not employed on that day.', 409);
		if (!served.some((t) => t.id === input.mealTypeId))
			throw new AppError('not_served', 'That meal is not served on that day.', 409);
		const values = { status: input.status, guestQty: input.guestQty, updatedByUserId: m.user.userId };
		await tx
			.insert(mealOrders)
			.values({ tenantId: m.tenant.id, employeeId: e.id, date: input.date, mealTypeId: input.mealTypeId, ...values })
			.onConflictDoUpdate({
				target: [mealOrders.tenantId, mealOrders.employeeId, mealOrders.date, mealOrders.mealTypeId],
				set: values
			});
	});
}

const rangeSchema = z
	.object({ from: z.iso.date('Choose the first day.'), to: z.iso.date('Choose the last day.') })
	.refine((v) => v.from <= v.to, 'The last day cannot be before the first day.')
	.refine((v) => datesBetween(v.from, v.to).length <= MAX_RANGE, `Choose at most ${MAX_RANGE} days at once.`);

export async function skipMeals(m: Member, raw: Record<string, string>) {
	const input = rangeSchema.parse(raw);
	return withTenant(userCtx(m), async (tx) => {
		const e = await self(tx, m.access);
		const r = await rules(tx);
		if (input.to > addDays(r.today, MAX_AHEAD))
			throw new AppError('too_far', `Meals can be chosen up to ${MAX_AHEAD} days ahead.`, 400);
		const served = await menu(tx, input.to);
		const off = await holidaySet(tx, input.from, input.to);
		const prepared = await preparedSet(tx, input.from, input.to);
		const rows = datesBetween(input.from, input.to)
			.filter((d) => isOpen(r, d) && !prepared.has(d) && employedOn(e, d))
			.filter((d) => !r.workingDaysOnly || (!weekend(r, d) && !off.has(d)))
			.flatMap((date) =>
				served(date).map((t) => ({
					tenantId: m.tenant.id,
					employeeId: e.id,
					date,
					mealTypeId: t.id,
					status: 'opted_out',
					guestQty: 0,
					updatedByUserId: m.user.userId
				}))
			);
		if (rows.length)
			await tx
				.insert(mealOrders)
				.values(rows)
				.onConflictDoUpdate({
					target: [mealOrders.tenantId, mealOrders.employeeId, mealOrders.date, mealOrders.mealTypeId],
					set: { status: 'opted_out', guestQty: 0, updatedByUserId: m.user.userId }
				});
		return new Set(rows.map((x) => x.date)).size;
	});
}

export async function prepareMealDay(tx: Tx, tenantId: string, date: string) {
	const [day] = await tx
		.insert(mealDays)
		.values({ tenantId, date })
		.onConflictDoNothing()
		.returning({ id: mealDays.id });
	if (!day) return false;
	const r = await rules(tx);
	const served = (await menu(tx, date))(date);
	if (!served.length) return true;
	const people = await tx
		.select({ id: employees.id })
		.from(employees)
		.where(
			and(
				lte(employees.joinDate, date),
				or(isNull(employees.exitDate), gte(employees.exitDate, date)),
				sql`${employees.status} <> 'exited'`
			)
		);
	const working = !weekend(r, date) && !(await holidaySet(tx, date, date)).size;
	const leave = await leaveSet(
		tx,
		date,
		date,
		people.map((p) => p.id)
	);
	const rows = people.flatMap((p) => {
		const status = defaultStatus(r, working, leave.has(`${p.id}:${date}`));
		return status
			? served.map((t) => ({ tenantId, employeeId: p.id, date, mealTypeId: t.id, status, guestQty: 0 }))
			: [];
	});
	if (rows.length) await tx.insert(mealOrders).values(rows).onConflictDoNothing();
	await tx
		.update(mealOrders)
		.set({ status: 'auto_off' })
		.where(
			and(
				eq(mealOrders.date, date),
				notInArray(
					mealOrders.employeeId,
					people.map((p) => p.id)
				)
			)
		);
	for (const t of served)
		await tx
			.update(mealOrders)
			.set({ unitCost: t.unitCost, subsidyPct: t.subsidyPct })
			.where(and(eq(mealOrders.date, date), eq(mealOrders.mealTypeId, t.id)));
	return true;
}

export async function runMealDays(tenantId: string) {
	await withTenant(systemCtx(tenantId), async (tx) => {
		const r = await rules(tx);
		for (const d of datesBetween(addDays(r.today, -3), addDays(r.today, -1))) await prepareMealDay(tx, tenantId, d);
		if (now() >= cutoffAt(r, r.today)) await prepareMealDay(tx, tenantId, r.today);
		const due = await tx
			.select({ id: mealDays.id, date: mealDays.date })
			.from(mealDays)
			.where(and(eq(mealDays.locked, false), isNull(mealDays.lockedAt), lte(mealDays.date, addDays(r.today, -1))));
		const ids = due.filter((d) => now() >= zonedInstant(`${addDays(d.date, 1)}T02:00`, r.timeZone)).map((d) => d.id);
		if (ids.length) await tx.update(mealDays).set({ locked: true, lockedAt: now() }).where(inArray(mealDays.id, ids));
	});
}

export async function runMeals() {
	const list = await authPool().db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
	for (const t of list)
		await runMealDays(t.id).catch((err) =>
			log.error({ tenantId: t.id, err: (err as Error).message }, 'meal days failed')
		);
}

const dateSchema = z.iso.date('Choose a day.');

export async function mealDay(tx: Tx, access: Access, raw: string) {
	const date = dateSchema.parse(raw);
	const scope = await resolveScope(tx, access, 'meal.manage');
	const r = await rules(tx);
	const [day] = await tx.select().from(mealDays).where(eq(mealDays.date, date));
	const served = (await menu(tx, date))(date);
	const rows = day
		? await tx
				.select({
					id: mealOrders.id,
					employeeId: mealOrders.employeeId,
					name: employees.fullName,
					code: employees.code,
					mealTypeId: mealOrders.mealTypeId,
					meal: mealTypes.name,
					status: mealOrders.status,
					guestQty: mealOrders.guestQty
				})
				.from(mealOrders)
				.innerJoin(employees, eq(employees.id, mealOrders.employeeId))
				.innerJoin(mealTypes, eq(mealTypes.id, mealOrders.mealTypeId))
				.where(and(eq(mealOrders.date, date), scopeWhere(scope, mealOrders.employeeId)))
				.orderBy(asc(mealTypes.name), asc(employees.fullName))
		: [];
	const totals = [...new Set(rows.map((x) => x.meal))].map((meal) => {
		const own = rows.filter((x) => x.meal === meal);
		return {
			meal,
			plates: own.filter((x) => x.status === 'ordered').length,
			guests: own.reduce((n, x) => n + x.guestQty, 0)
		};
	});
	return {
		date,
		prepared: !!day,
		locked: !!day?.locked,
		canPrepare: !day && !isOpen(r, date),
		served: served.map((t) => t.name),
		totals,
		rows
	};
}

export async function prepareDayNow(m: Member, raw: string) {
	const date = dateSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const r = await rules(tx);
		if (isOpen(r, date))
			throw new AppError('too_early', `Employees can still change ${date} until ${r.cutoff.slice(0, 5)}.`, 409);
		await prepareMealDay(tx, m.tenant.id, date);
	});
}

async function openDay(tx: Tx, date: string) {
	const [day] = await tx.select().from(mealDays).where(eq(mealDays.date, date)).for('update');
	if (!day) throw new AppError('not_prepared', 'Meals for that day are not prepared yet.', 409);
	return day;
}

const adjustSchema = z.object({
	date: dateSchema,
	orderId: z.uuid({ error: 'Choose a meal.' }),
	status: z.enum(['ordered', 'opted_out'], 'Choose whether they ate.'),
	guestQty: choiceSchema.shape.guestQty
});

export async function adjustMeal(m: Member, raw: Record<string, string>) {
	const input = adjustSchema.parse(raw);
	const ctx = userCtx(m);
	await withTenant(ctx, async (tx) => {
		const day = await openDay(tx, input.date);
		if (day.locked) throw new AppError('locked', 'That day is locked. Unlock it first.', 409);
		const [o] = await tx
			.select()
			.from(mealOrders)
			.where(and(eq(mealOrders.id, input.orderId), eq(mealOrders.date, input.date)));
		if (!o || !inScope(await resolveScope(tx, m.access, 'meal.manage'), o.employeeId))
			throw new AppError('not_found', 'That meal does not exist.', 404);
		await tx
			.update(mealOrders)
			.set({ status: input.status, guestQty: input.guestQty, updatedByUserId: m.user.userId })
			.where(eq(mealOrders.id, o.id));
		await auditEvent(
			tx,
			ctx,
			'meal_orders',
			o.id,
			`Meal on ${o.date} changed from ${o.status} with ${o.guestQty} guests to ${input.status} with ${input.guestQty} guests`
		);
	});
}

export async function lockMealDay(m: Member, raw: string, locked: boolean) {
	const date = dateSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const day = await openDay(tx, date);
		if (day.locked === locked) return;
		await tx
			.update(mealDays)
			.set(locked ? { locked, lockedAt: now(), lockedByUserId: m.user.userId } : { locked })
			.where(eq(mealDays.id, day.id));
	});
}
