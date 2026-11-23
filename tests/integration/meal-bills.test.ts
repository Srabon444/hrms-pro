import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { addDays } from '../../src/lib/server/dates';
import {
	employees,
	holidays,
	mealBillLines,
	mealBills,
	mealDays,
	mealOrders,
	mealTypePrices,
	mealTypes,
	memberships
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import {
	generateBills,
	issueBills,
	lastPeriod,
	myBills,
	periodBills,
	periodRange,
	voidBill
} from '../../src/lib/server/meal-bills';
import { adjustMeal, lockMealDay, prepareMealDay } from '../../src/lib/server/meal-orders';
import { mealSetup, saveMealType, saveVendor } from '../../src/lib/server/meals';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
let lunch = '';
const ids: Record<string, string> = {};
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
const hire = (fullName: string) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01'
	});

async function member(key: string, roleKeys: string[], employeeId: string | null) {
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

const prepare = (period: string) =>
	withTenant(sys(), async (tx) => {
		const { from, to } = periodRange(period);
		for (let d = from; d <= to; d = addDays(d, 1)) await prepareMealDay(tx, tenant.id, d);
	});
const lockAll = (period: string) =>
	withTenant(sys(), (tx) => {
		const { from, to } = periodRange(period);
		return tx
			.update(mealDays)
			.set({ locked: true })
			.where(and(gte(mealDays.date, from), lte(mealDays.date, to)));
	});
const bills = (period: string) =>
	withTenant(sys(), async (tx) =>
		(
			await tx
				.select({
					id: mealBills.id,
					name: employees.fullName,
					status: mealBills.status,
					mode: mealBills.billingMode,
					total: mealBills.total
				})
				.from(mealBills)
				.innerJoin(employees, eq(employees.id, mealBills.employeeId))
				.where(eq(mealBills.period, period))
				.orderBy(asc(employees.fullName), asc(mealBills.createdAt))
		).map((b) => [b.name, b.status, b.mode, b.total, b.id])
	);
const order = (employeeId: string, date: string) =>
	withTenant(sys(), async (tx) => {
		const [o] = await tx
			.select({ id: mealOrders.id })
			.from(mealOrders)
			.where(and(eq(mealOrders.employeeId, employeeId), eq(mealOrders.date, date)));
		return o.id;
	});
const bill = (key: string, period: string) => generateBills(who[key], { period });

beforeAll(async () => {
	tenant = await createTenant('meal-bills');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.ana = await hire('Ana');
	ids.ben = await hire('Ben');
	ids.cat = await hire('Cat');
	await member('ana', ['employee'], ids.ana);
	await member('mm', ['meal_manager'], null);
	const ctx = { tenantId: tenant.id, actor: 'user' as const };
	await saveVendor(ctx, '', { name: 'Rice Bowl', contact: '', active: 'on' });
	const setup = await withTenant(sys(), mealSetup);
	await saveMealType(ctx, '', { name: 'Lunch', vendorId: setup.vendors[0].id, active: 'on' });
	lunch = (await withTenant(sys(), mealSetup)).types[0].id;
	await withTenant(sys(), async (tx) => {
		await tx
			.insert(mealTypePrices)
			.values({ tenantId: tenant.id, mealTypeId: lunch, effectiveFrom: '2026-02-01', unitCost: 8051, subsidyPct: 50 });
		await tx.insert(holidays).values({ tenantId: tenant.id, date: '2026-02-26', name: 'Holiday' });
		await tx.update(employees).set({ status: 'notice', exitDate: '2026-02-10' }).where(eq(employees.id, ids.cat));
		await tx.insert(mealOrders).values([
			{ tenantId: tenant.id, employeeId: ids.ana, date: '2026-02-02', mealTypeId: lunch, status: 'opted_out' },
			{
				tenantId: tenant.id,
				employeeId: ids.ana,
				date: '2026-02-03',
				mealTypeId: lunch,
				status: 'ordered',
				guestQty: 2
			}
		]);
	});
});

afterAll(closePools);

describe('meal bills', () => {
	it('works out month ranges', () => {
		expect(periodRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
		expect(periodRange('2025-12')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
		expect(lastPeriod('2026-01-15')).toBe('2025-12');
		expect(lastPeriod('2026-03-01')).toBe('2026-02');
	});

	it('bills each employee their share for a locked month and issues the bills once', async () => {
		expect(await code(bill('mm', '2026-02'))).toBe('unlocked_days');
		await prepare('2026-02');
		await withTenant(sys(), async (tx) => {
			await prepareMealDay(tx, tenant.id, '2026-03-01');
			await tx.delete(mealDays).where(inArray(mealDays.date, ['2026-02-06', '2026-02-26']));
		});
		await withTenant(sys(), (tx) => tx.update(employees).set({ status: 'exited' }).where(eq(employees.id, ids.cat)));
		const view = await withTenant(sys(), (tx) => periodBills(tx, who.mm.access, '2026-02'));
		expect(view.unlocked).toHaveLength(26);
		expect(await code(bill('mm', '2026-13'))).toBe('invalid');
		await lockAll('2026-02');
		await withTenant(sys(), (tx) => tx.update(mealDays).set({ locked: false }).where(eq(mealDays.date, '2026-02-27')));
		expect(await code(bill('mm', '2026-02'))).toBe('unlocked_days');
		await lockAll('2026-02');

		expect(await bill('mm', '2026-02')).toBe(3);
		expect(await bill('mm', '2026-02')).toBe(3);
		const share = 4026;
		expect((await bills('2026-02')).map((b) => b.slice(0, 4))).toEqual([
			['Ana', 'draft', 'payroll', 18 * share + 2 * 8051],
			['Ben', 'draft', 'payroll', 19 * share],
			['Cat', 'draft', 'direct', 8 * share]
		]);
		expect(await withTenant(sys(), (tx) => myBills(tx, who.ana.access))).toEqual([]);

		expect(await issueBills(who.mm, { period: '2026-02' })).toBe(3);
		expect(new Set((await bills('2026-02')).map((b) => b[1]))).toEqual(new Set(['issued']));
		const [mine] = await withTenant(sys(), (tx) => myBills(tx, who.ana.access));
		expect(mine).toMatchObject({ period: '2026-02', status: 'issued', total: 18 * share + 2 * 8051, paid: 0 });
		expect(mine.lines).toHaveLength(18);
		expect(mine.lines.slice(0, 2).map((l) => [l.date, l.kind, l.plates, l.guests, l.amount])).toEqual([
			['2026-02-01', 'meal', 1, 0, share],
			['2026-02-03', 'meal', 1, 2, share + 2 * 8051]
		]);
		await withTenant(sys(), (tx) =>
			tx
				.update(mealBills)
				.set({ status: 'paid' })
				.where(and(eq(mealBills.period, '2026-02'), eq(mealBills.employeeId, ids.cat)))
		);
		expect(await bill('mm', '2026-02')).toBe(0);
		expect(await issueBills(who.mm, { period: '2026-02' })).toBe(0);
		expect(await bills('2026-02')).toHaveLength(3);
	});

	it('carries corrections to an issued month onto the next bill exactly once', async () => {
		const skipped = await order(ids.ana, '2026-02-02');
		const ate = await order(ids.ben, '2026-02-03');
		await lockMealDay(who.mm, '2026-02-02', false);
		await lockMealDay(who.mm, '2026-02-03', false);
		await adjustMeal(who.mm, { date: '2026-02-02', orderId: skipped, status: 'ordered', guestQty: '1' });
		await adjustMeal(who.mm, { date: '2026-02-03', orderId: ate, status: 'opted_out', guestQty: '0' });
		expect(await code(bill('mm', '2026-02'))).toBe('unlocked_days');
		await lockMealDay(who.mm, '2026-02-02', true);
		await lockMealDay(who.mm, '2026-02-03', true);
		expect(await bill('mm', '2026-02')).toBe(0);

		await prepare('2026-03');
		await lockAll('2026-03');
		expect(await bill('mm', '2026-03')).toBe(2);
		expect(await bill('mm', '2026-03')).toBe(2);
		const lines = (billId: string) =>
			withTenant(sys(), async (tx) =>
				(
					await tx
						.select()
						.from(mealBillLines)
						.where(and(eq(mealBillLines.billId, billId), eq(mealBillLines.kind, 'adjustment')))
				).map((l) => [l.date, l.plates, l.guests, l.amount])
			);
		const march = await bills('2026-03');
		expect(march.map((b) => b[0])).toEqual(['Ana', 'Ben']);
		expect(await lines(march[0][4] as string)).toEqual([['2026-02-02', 1, 1, 4026 + 8051]]);
		expect(await lines(march[1][4] as string)).toEqual([['2026-02-03', 0, 0, -4026]]);
		const weekdays = 23;
		expect(march.map((b) => b[3])).toEqual([weekdays * 4026 + 4026 + 8051, weekdays * 4026 - 4026]);

		expect(await issueBills(who.mm, { period: '2026-03' })).toBe(2);
		await withTenant(sys(), (tx) => tx.update(mealTypes).set({ active: false }).where(eq(mealTypes.id, lunch)));
		expect(await bill('mm', '2026-04')).toBe(0);
		await withTenant(sys(), (tx) => tx.update(mealTypes).set({ active: true }).where(eq(mealTypes.id, lunch)));

		const anaMarch = (await bills('2026-03'))[0][4] as string;
		expect(await code(voidBill(who.mm, { billId: anaMarch }))).toBe('ok');
		expect(await code(voidBill(who.mm, { billId: anaMarch }))).toBe('not_voidable');
		expect(await bill('mm', '2026-03')).toBe(1);
		const again = await bills('2026-03');
		expect(again.map((b) => b.slice(0, 2))).toEqual([
			['Ana', 'void'],
			['Ana', 'draft'],
			['Ben', 'issued']
		]);
		expect(again[1][3]).toBe(march[0][3]);
		expect(await code(voidBill(who.mm, { billId: again[1][4] as string }))).toBe('not_voidable');
		await withTenant(sys(), (tx) =>
			tx
				.update(mealBills)
				.set({ paid: 100 })
				.where(eq(mealBills.id, again[2][4] as string))
		);
		expect(await code(voidBill(who.mm, { billId: again[2][4] as string }))).toBe('not_voidable');
	});

	it('keeps tenant-wide billing to people who bill everyone', async () => {
		const narrow = {
			...who.mm,
			access: { ...who.mm.access, grants: { ...who.mm.access.grants, 'meal.billing': ['own'] } }
		} as Member;
		expect(await code(generateBills(narrow, { period: '2026-02' }))).toBe('forbidden');
		expect(await code(issueBills(narrow, { period: '2026-02' }))).toBe('forbidden');
		const feb = await bills('2026-02');
		expect(await code(voidBill(narrow, { billId: feb[0][4] as string }))).toBe('not_found');
		const view = await withTenant(sys(), (tx) => periodBills(tx, narrow.access, '2026-02'));
		expect(view).toMatchObject({ canRun: false, bills: [] });
		expect((await withTenant(sys(), (tx) => periodBills(tx, who.mm.access, '2026-02'))).bills).toHaveLength(3);
	});
});
