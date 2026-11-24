import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import {
	auditLog,
	employees,
	holidays,
	leaveRequestDays,
	leaveRequests,
	leaveTypes,
	mealDays,
	mealOrders,
	mealTypePrices,
	memberships,
	tenantSettings
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import {
	adjustMeal,
	chooseMeal,
	lockMealDay,
	mealDay,
	myMeals,
	prepareDayNow,
	prepareMealDay,
	runMealDays,
	skipMeals
} from '../../src/lib/server/meal-orders';
import { mealSetup, saveMealType, saveVendor } from '../../src/lib/server/meals';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const types: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (fullName: string, extra: Record<string, string> = {}) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01',
		...extra
	});

async function member(key: string, roleKeys: string[], employeeId: string) {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const at = <T>(iso: string, fn: () => Promise<T>) => withTestNow(`${iso}+06:00`, fn);
const choose = (key: string, iso: string, date: string, meal: string, status = 'ordered', guestQty = '0') =>
	at(iso, () => code(chooseMeal(who[key], { date, mealTypeId: types[meal], status, guestQty })));
const orders = (date: string) =>
	withTenant(sys(), async (tx) =>
		(
			await tx
				.select({
					name: employees.fullName,
					status: mealOrders.status,
					guests: mealOrders.guestQty,
					cost: mealOrders.unitCost,
					subsidy: mealOrders.subsidyPct,
					typeId: mealOrders.mealTypeId
				})
				.from(mealOrders)
				.innerJoin(employees, eq(employees.id, mealOrders.employeeId))
				.where(eq(mealOrders.date, date))
				.orderBy(asc(employees.fullName))
		)
			.map((o) => [o.name, o.typeId === types.lunch ? 'Lunch' : 'Dinner', o.status, o.guests, o.cost, o.subsidy])
			.sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`))
	);
const dayRow = (date: string) =>
	withTenant(sys(), async (tx) => (await tx.select().from(mealDays).where(eq(mealDays.date, date)))[0] ?? null);

beforeAll(async () => {
	tenant = await createTenant('meal-orders');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.ana = await hire('Ana');
	ids.ben = await hire('Ben');
	ids.cat = await hire('Cat', { joinDate: '2026-01-01' });
	ids.dan = await hire('Dan', { joinDate: '2026-03-15', status: 'onboarding' });
	ids.mm = await hire('Mia');
	ids.eve = await hire('Eve');
	ids.fay = await hire('Fay');
	await member('ana', ['employee'], ids.ana);
	await member('dan', ['employee'], ids.dan);
	await member('mm', ['meal_manager', 'employee'], ids.mm);
	await member('eve', ['employee'], ids.eve);
	await member('hr', ['meal_manager'], null as never);
	const ctx = { tenantId: tenant.id, actor: 'user' as const };
	await saveVendor(ctx, '', { name: 'Rice Bowl', contact: '', active: 'on' });
	const setup = await withTenant(sys(), mealSetup);
	for (const name of ['Lunch', 'Dinner'])
		await saveMealType(ctx, '', { name, vendorId: setup.vendors[0].id, active: 'on' });
	for (const t of (await withTenant(sys(), mealSetup)).types) types[t.name.toLowerCase()] = t.id;
	await withTenant(sys(), async (tx) => {
		await tx.update(employees).set({ status: 'exited', exitDate: '2026-03-05' }).where(eq(employees.id, ids.cat));
		await tx.update(employees).set({ status: 'notice', exitDate: '2026-03-12' }).where(eq(employees.id, ids.eve));
		await tx.update(employees).set({ status: 'exited' }).where(eq(employees.id, ids.fay));
		await tx.insert(mealTypePrices).values([
			{ tenantId: tenant.id, mealTypeId: types.lunch, effectiveFrom: '2026-03-01', unitCost: 8000, subsidyPct: 50 },
			{ tenantId: tenant.id, mealTypeId: types.dinner, effectiveFrom: '2026-03-12', unitCost: 10000, subsidyPct: 0 }
		]);
		await tx.insert(mealOrders).values({
			tenantId: tenant.id,
			employeeId: ids.cat,
			date: '2026-03-10',
			mealTypeId: types.lunch,
			status: 'ordered'
		});
		await tx.insert(holidays).values({ tenantId: tenant.id, date: '2026-03-17', name: 'Holiday' });
		const [casual] = await tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'casual'));
		const [approved, pending] = await tx
			.insert(leaveRequests)
			.values(
				[ids.ben, ids.mm].map((employeeId, n) => ({
					tenantId: tenant.id,
					employeeId,
					leaveTypeId: casual.id,
					startDate: '2026-03-11',
					endDate: '2026-03-11',
					session: 'full',
					days: 1,
					status: n ? 'pending' : 'approved',
					requestedByUserId: who.ana.user.userId
				}))
			)
			.returning({ id: leaveRequests.id });
		await tx.insert(leaveRequestDays).values(
			[
				[approved.id, ids.ben, 'approved'],
				[pending.id, ids.mm, 'pending']
			].map(([requestId, employeeId, status]) => ({
				tenantId: tenant.id,
				requestId,
				employeeId,
				date: '2026-03-11',
				session: 'full',
				fiscalYear: 2025,
				status
			}))
		);
	});
});

afterAll(closePools);

describe('meal orders', () => {
	it('lets employees choose meals until the cutoff of that day', async () => {
		const morning = '2026-03-10T09:00:00';
		expect(await choose('ana', morning, '2026-03-10', 'lunch', 'opted_out')).toBe('ok');
		expect(await choose('ana', '2026-03-10T10:00:00', '2026-03-10', 'lunch')).toBe('closed');
		expect(await choose('ana', morning, '2026-03-09', 'lunch')).toBe('closed');
		expect(await choose('ana', morning, '2026-05-20', 'lunch')).toBe('too_far');
		expect(await choose('ana', morning, '2026-03-11', 'dinner')).toBe('not_served');
		expect(await choose('ana', morning, '2026-03-13', 'lunch')).toBe('not_served');
		expect(await choose('ana', morning, '2026-03-11', 'lunch', 'ordered', '11')).toBe('invalid');
		expect(await choose('ana', morning, '2026-03-11', 'lunch', 'auto_off')).toBe('invalid');
		expect(await choose('dan', morning, '2026-03-12', 'lunch')).toBe('not_employed');
		expect(await choose('dan', morning, '2026-03-16', 'lunch')).toBe('ok');
		expect(await choose('eve', morning, '2026-03-16', 'lunch')).toBe('not_employed');
		expect(await choose('hr', morning, '2026-03-10', 'lunch')).toBe('no_employee');
		expect(await at(morning, () => withTenant(sys(), (tx) => myMeals(tx, who.hr.access)))).toBeNull();
		const eveDays = await at(morning, () => withTenant(sys(), (tx) => myMeals(tx, who.eve.access)));
		expect(eveDays!.days.map((d) => d.date)).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);

		const mine = await at(morning, () => withTenant(sys(), (tx) => myMeals(tx, who.ana.access)));
		const shown = (date: string) =>
			mine!.days.find((d) => d.date === date)!.meals.map((m) => [m.name, m.status, m.guestQty, m.unitCost]);
		expect(mine!.days).toHaveLength(14);
		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ mealOrderDaysAhead: 5 }));
		const short = await at(morning, () => withTenant(sys(), (tx) => myMeals(tx, who.ana.access)));
		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ mealOrderDaysAhead: 14 }));
		expect(short!.days).toHaveLength(5);
		expect(shown('2026-03-10')).toEqual([['Lunch', 'opted_out', 0, 8000]]);
		expect(shown('2026-03-11')).toEqual([['Lunch', 'ordered', 0, 8000]]);
		expect(shown('2026-03-12')).toEqual([
			['Dinner', 'ordered', 0, 10000],
			['Lunch', 'ordered', 0, 8000]
		]);
		expect(shown('2026-03-13')).toEqual([]);
		expect(shown('2026-03-17')).toEqual([]);
		expect(mine!.days[0]).toMatchObject({ date: '2026-03-10', open: true, working: true });
		const late = await at('2026-03-10T10:00:00', () => withTenant(sys(), (tx) => myMeals(tx, who.ana.access)));
		expect(late!.days[0].open).toBe(false);
		const danDays = await at(morning, () => withTenant(sys(), (tx) => myMeals(tx, who.dan.access)));
		expect(danDays!.days[0].date).toBe('2026-03-15');

		const skip = (from: string, to: string) => at('2026-03-10T09:30:00', () => skipMeals(who.ana, { from, to }));
		expect(await skip('2026-03-10', '2026-03-14')).toBe(3);
		expect(await code(skip('2026-03-12', '2026-03-11'))).toBe('invalid');
		expect(await code(skip('2026-03-10', '2026-05-15'))).toBe('invalid');
		expect(await code(skip('2026-04-01', '2026-05-12'))).toBe('too_far');
		expect((await orders('2026-03-12')).filter((o) => o[0] === 'Ana')).toEqual([
			['Ana', 'Dinner', 'opted_out', 0, null, null],
			['Ana', 'Lunch', 'opted_out', 0, null, null]
		]);
		expect(await choose('ana', morning, '2026-03-11', 'lunch', 'ordered', '2')).toBe('ok');
	});

	it('prepares each day at the cutoff from choices, leave, holidays and the ordering mode', async () => {
		await at('2026-03-11T09:59:00', () => runMealDays(tenant.id));
		expect(await dayRow('2026-03-11')).toBeNull();
		expect(await dayRow('2026-03-10')).not.toBeNull();
		expect(await dayRow('2026-03-08')).not.toBeNull();
		expect(await orders('2026-03-10')).toEqual([
			['Ana', 'Lunch', 'opted_out', 0, 8000, 50],
			['Ben', 'Lunch', 'ordered', 0, 8000, 50],
			['Cat', 'Lunch', 'auto_off', 0, 8000, 50],
			['Eve', 'Lunch', 'ordered', 0, 8000, 50],
			['Mia', 'Lunch', 'ordered', 0, 8000, 50]
		]);
		await at('2026-03-11T10:00:00', () => runMealDays(tenant.id));
		expect(await orders('2026-03-11')).toEqual([
			['Ana', 'Lunch', 'ordered', 2, 8000, 50],
			['Ben', 'Lunch', 'auto_off', 0, 8000, 50],
			['Eve', 'Lunch', 'ordered', 0, 8000, 50],
			['Mia', 'Lunch', 'ordered', 0, 8000, 50]
		]);
		expect(await choose('ana', '2026-03-11T09:00:00', '2026-03-11', 'lunch', 'opted_out')).toBe('closed');
		const after = await at('2026-03-11T09:00:00', () => withTenant(sys(), (tx) => myMeals(tx, who.ana.access)));
		expect(after!.days[0]).toMatchObject({ date: '2026-03-11', open: false });
		expect(await at('2026-03-11T09:00:00', () => skipMeals(who.ana, { from: '2026-03-11', to: '2026-03-12' }))).toBe(1);
		expect((await orders('2026-03-11'))[0]).toEqual(['Ana', 'Lunch', 'ordered', 2, 8000, 50]);
		await withTenant(sys(), (tx) =>
			tx.update(mealTypePrices).set({ unitCost: 9000 }).where(eq(mealTypePrices.mealTypeId, types.lunch))
		);
		await at('2026-03-11T11:00:00', () => runMealDays(tenant.id));
		expect((await orders('2026-03-11'))[0]).toEqual(['Ana', 'Lunch', 'ordered', 2, 8000, 50]);

		await at('2026-03-12T01:59:00', () => runMealDays(tenant.id));
		expect((await dayRow('2026-03-11'))!.locked).toBe(false);
		await at('2026-03-12T02:00:00', () => runMealDays(tenant.id));
		expect((await dayRow('2026-03-11'))!.locked).toBe(true);
		expect((await dayRow('2026-03-10'))!.locked).toBe(true);

		expect(
			await at('2026-03-13T12:00:00', () => withTenant(sys(), (tx) => prepareMealDay(tx, tenant.id, '2026-03-13')))
		).toBe(true);
		expect(
			await at('2026-03-13T12:00:00', () => withTenant(sys(), (tx) => prepareMealDay(tx, tenant.id, '2026-03-13')))
		).toBe(false);
		expect(await orders('2026-03-13')).toEqual([]);
		expect(await dayRow('2026-03-13')).not.toBeNull();

		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ mealMode: 'opt_in', mealWorkingDaysOnly: false }));
		await at('2026-03-16T10:30:00', () => withTenant(sys(), (tx) => prepareMealDay(tx, tenant.id, '2026-03-16')));
		expect((await orders('2026-03-16')).map((o) => [o[0], o[1], o[2]])).toEqual([
			['Ana', 'Dinner', 'opted_out'],
			['Ana', 'Lunch', 'opted_out'],
			['Ben', 'Dinner', 'opted_out'],
			['Ben', 'Lunch', 'opted_out'],
			['Dan', 'Dinner', 'opted_out'],
			['Dan', 'Lunch', 'ordered'],
			['Mia', 'Dinner', 'opted_out'],
			['Mia', 'Lunch', 'opted_out']
		]);
		await at('2026-03-17T10:30:00', () => withTenant(sys(), (tx) => prepareMealDay(tx, tenant.id, '2026-03-17')));
		expect(new Set((await orders('2026-03-17')).map((o) => o[2]))).toEqual(new Set(['auto_off']));
		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ mealMode: 'opt_out', mealWorkingDaysOnly: true }));
	});

	it('lets the meal manager correct a day, lock it and unlock it', async () => {
		const view = (date: string) =>
			at('2026-03-12T12:00:00', () => withTenant(sys(), (tx) => mealDay(tx, who.mm.access, date)));
		const d11 = await view('2026-03-11');
		expect(d11).toMatchObject({ prepared: true, locked: true, canPrepare: false });
		expect(d11.totals).toEqual([{ meal: 'Lunch', plates: 3, guests: 2 }]);
		const ben = d11.rows.find((r) => r.name === 'Ben')!;
		const adjust = (orderId: string, date = '2026-03-11') =>
			at('2026-03-12T12:00:00', () => code(adjustMeal(who.mm, { date, orderId, status: 'ordered', guestQty: '1' })));
		expect(await adjust(ben.id)).toBe('locked');
		expect(await at('2026-03-12T12:00:00', () => code(lockMealDay(who.mm, '2026-03-11', false)))).toBe('ok');
		const narrow = {
			...who.mm,
			access: { ...who.mm.access, grants: { ...who.mm.access.grants, 'meal.manage': ['own'] } }
		} as Member;
		expect(
			await at('2026-03-12T12:00:00', () =>
				code(adjustMeal(narrow, { date: '2026-03-11', orderId: ben.id, status: 'ordered', guestQty: '1' }))
			)
		).toBe('not_found');
		const mine = await at('2026-03-12T12:00:00', () =>
			withTenant(sys(), (tx) => mealDay(tx, narrow.access, '2026-03-11'))
		);
		expect(mine.rows.map((r) => r.name)).toEqual(['Mia']);
		expect(await adjust(ben.id)).toBe('ok');
		expect(await adjust(ben.id, '2026-03-10')).toBe('locked');
		expect(await adjust(crypto.randomUUID())).toBe('not_found');
		expect(await adjust(ben.id, '2026-03-20')).toBe('not_prepared');
		expect((await view('2026-03-11')).totals).toEqual([{ meal: 'Lunch', plates: 4, guests: 3 }]);
		const events = await withTenant(sys(), (tx) =>
			tx
				.select({ event: auditLog.event })
				.from(auditLog)
				.where(and(eq(auditLog.tableName, 'meal_orders'), eq(auditLog.rowId, ben.id)))
		);
		expect(events.map((e) => e.event)).toEqual([
			'Meal on 2026-03-11 changed from auto_off with 0 guests to ordered with 1 guests'
		]);
		await at('2026-03-12T03:00:00', () => runMealDays(tenant.id));
		expect((await dayRow('2026-03-11'))!.locked).toBe(false);
		expect(await at('2026-03-12T12:00:00', () => code(lockMealDay(who.mm, '2026-03-11', true)))).toBe('ok');
		expect((await dayRow('2026-03-11'))!.locked).toBe(true);

		const d12 = await at('2026-03-12T09:00:00', () =>
			withTenant(sys(), (tx) => mealDay(tx, who.mm.access, '2026-03-12'))
		);
		expect(d12).toMatchObject({ prepared: false, canPrepare: false, served: ['Dinner', 'Lunch'] });
		expect(await at('2026-03-12T09:00:00', () => code(prepareDayNow(who.mm, '2026-03-12')))).toBe('too_early');
		expect(await at('2026-03-12T10:01:00', () => code(prepareDayNow(who.mm, '2026-03-14')))).toBe('too_early');
		expect(await at('2026-03-12T10:01:00', () => code(prepareDayNow(who.mm, '2026-03-12')))).toBe('ok');
		expect(await dayRow('2026-03-12')).not.toBeNull();
	});
});
