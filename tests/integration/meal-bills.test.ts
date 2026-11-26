import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFiles, openFile } from '../../src/lib/server/attachments';
import { closePools } from '../../src/lib/server/db';
import { processors } from '../../src/lib/server/jobs';
import { addDays } from '../../src/lib/server/dates';
import { taka } from '../../src/lib/money';
import {
	employees,
	holidays,
	mealBillLines,
	mealBills,
	mealDays,
	mealOrders,
	mealTypePrices,
	mealTypes,
	memberships,
	tenantSettings
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import {
	generateBills,
	issueBills,
	openBillPdf,
	sendMealBill,
	sweepMealBills,
	lastPeriod,
	mealDue,
	mealStatement,
	myBills,
	periodBills,
	periodRange,
	recordPayment,
	voidBill
} from '../../src/lib/server/meal-bills';
import { adjustMeal, lockMealDay, prepareMealDay } from '../../src/lib/server/meal-orders';
import { mealSetup, saveMealType, saveVendor } from '../../src/lib/server/meals';
import { closeQueues, queue, startWorker } from '../../src/lib/server/queue';
import { getObject } from '../../src/lib/server/storage';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { waitForMail } from '../mailpit';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
let lunch = '';
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const emails: Record<string, string> = {};
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
	emails[key] = u.email;
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
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
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

const mailer = startWorker('mail', processors.mail);

afterAll(async () => {
	await mailer.close();
	await closeQueues();
	await closePools();
});

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

	it('emails each employee their own bill as a PDF and lets only them and billing download it', async () => {
		const [ana, ben, cat] = (await bills('2026-02')).map((b) => String(b[4]));
		const benMail = `${ben.slice(0, 8)}@work.test`;
		await member('ben', ['employee'], ids.ben);
		await withTenant(sys(), async (tx) => {
			await tx.update(memberships).set({ status: 'disabled' }).where(eq(memberships.employeeId, ids.ben));
			await tx.update(tenantSettings).set({ legalName: 'Acme Foods Ltd' });
		});
		await withTenant(sys(), (tx) => tx.update(employees).set({ workEmail: benMail }).where(eq(employees.id, ids.ben)));
		await withTenant(sys(), (tx) =>
			tx.update(employees).set({ personalEmail: null, workEmail: null }).where(eq(employees.id, ids.cat))
		);
		for (const billId of [ana, ben, cat]) await sendMealBill({ tenantId: tenant.id, billId });

		const got = await waitForMail(emails.ana, 15_000, 'Meal bill for 2026-02');
		expect(got.text).toContain(`Total: ৳${taka(18 * 4026 + 2 * 8051)}.`);
		expect(got.text).toContain('deducted from your salary');
		expect(got.text).toContain('from Acme Foods Ltd is attached');
		expect(got.text).not.toContain(taka(19 * 4026));
		expect(got.attachments).toEqual(['meal-bill-2026-02.pdf']);
		expect((await waitForMail(benMail, 15_000, 'Meal bill for 2026-02')).text).toContain(`৳${taka(19 * 4026)}`);

		const keys = await withTenant(sys(), (tx) =>
			tx.select({ id: mealBills.id, key: mealBills.pdfKey }).from(mealBills).where(eq(mealBills.period, '2026-02'))
		);
		expect(keys.every((k) => k.key === `t/${tenant.id}/meal-bills/${k.id}.pdf`)).toBe(true);
		const stored = await getObject(`t/${tenant.id}/meal-bills/${ana}.pdf`);
		expect(Buffer.from(stored).subarray(0, 5).toString()).toBe('%PDF-');

		const mine = await openBillPdf(who.ana, ana);
		expect(mine.fileName).toBe('meal-bill-2026-02.pdf');
		expect(Buffer.from(mine.body).subarray(0, 5).toString()).toBe('%PDF-');
		expect(await code(openBillPdf(who.ana, ben))).toBe('not_found');
		expect(await code(openBillPdf(who.ana, 'nope'))).toBe('not_found');
		expect(await code(openBillPdf(who.mm, ben))).toBe('ok');
		await withTenant(sys(), (tx) => tx.update(mealBills).set({ status: 'draft' }).where(eq(mealBills.id, ben)));
		expect(await code(openBillPdf(who.mm, ben))).toBe('not_found');
		await sendMealBill({ tenantId: tenant.id, billId: ben });
		await withTenant(sys(), (tx) => tx.update(mealBills).set({ status: 'issued' }).where(eq(mealBills.id, ben)));
	});

	it('queues each issued bill once and requeues bills still without a PDF after an hour', async () => {
		const [ana, ben, cat] = (await bills('2026-02')).map((b) => String(b[4]));
		expect((await queue('meal-bills').getJob(`meal-bill-${ana}`))?.data).toEqual({ tenantId: tenant.id, billId: ana });
		const hourAgo = new Date(Date.now() - 3_600_000 - 60_000);
		await withTenant(sys(), async (tx) => {
			await tx.update(mealBills).set({ pdfKey: null, issuedAt: hourAgo }).where(eq(mealBills.id, ana));
			await tx.update(mealBills).set({ pdfKey: null, issuedAt: new Date() }).where(eq(mealBills.id, ben));
			await tx.update(mealBills).set({ issuedAt: hourAgo }).where(eq(mealBills.id, cat));
		});
		await sweepMealBills();
		const hour = Math.floor(Date.now() / 3_600_000);
		expect(await queue('meal-bills').getJob(`meal-bill-${ana}-retry-${hour}`)).toBeTruthy();
		expect(await queue('meal-bills').getJob(`meal-bill-${ben}-retry-${hour}`)).toBeFalsy();
		expect(await queue('meal-bills').getJob(`meal-bill-${cat}-retry-${hour}`)).toBeFalsy();
		await sendMealBill({ tenantId: tenant.id, billId: ana });
		await sendMealBill({ tenantId: tenant.id, billId: ben });
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

	it('records cash payments against direct bills and reports what the caterer and company pay', async () => {
		const [, , cat] = await bills('2026-02');
		const catBill = cat[4] as string;
		await withTenant(sys(), (tx) => tx.update(mealBills).set({ status: 'issued' }).where(eq(mealBills.id, catBill)));
		const pay = (billId: string, amount: string, paidOn = '2026-03-05', method = 'cash') =>
			code(recordPayment(who.mm, { billId, amount, paidOn, method, note: '' }));
		const total = 8 * 4026;
		expect(await pay(catBill, '0')).toBe('invalid');
		expect(await pay(catBill, '1.234')).toBe('invalid');
		expect(await pay(catBill, '10', '2026-03-05', 'card')).toBe('invalid');
		expect(await pay(catBill, '10', '2999-01-01')).toBe('future_payment');
		expect(await pay(catBill, ((total + 1) / 100).toFixed(2))).toBe('overpaid');
		expect(await pay(catBill, '100.50')).toBe('ok');
		const pdf = (name: string) => new File([`%PDF-1.7 ${name}`], name, { type: 'application/pdf' });
		const [slip] = await addFiles(who.mm, 'meal_bill', catBill, [pdf('slip.pdf')]);
		expect((await openFile(who.mm, slip)).fileName).toBe('slip.pdf');
		expect(await code(openFile(who.ana, slip))).toBe('not_found');
		expect(await code(addFiles(who.ana, 'meal_bill', catBill, [pdf('x.pdf')]))).toBe('not_found');
		const [, , afterOne] = await bills('2026-02');
		expect(afterOne[1]).toBe('partially_paid');
		expect(await pay(catBill, (total / 100).toFixed(2))).toBe('overpaid');
		expect(await code(voidBill(who.mm, { billId: catBill }))).toBe('not_voidable');
		await withTenant(sys(), (tx) =>
			tx.update(memberships).set({ employeeId: ids.cat }).where(eq(memberships.userId, who.ana.user.userId))
		);
		const catAccess = { ...who.ana.access, employeeId: ids.cat };
		expect(await withTenant(sys(), (tx) => mealDue(tx, catAccess))).toBe(total - 10050);
		expect(await pay(catBill, ((total - 10050) / 100).toFixed(2), '2026-03-06', 'mobile')).toBe('ok');
		expect((await bills('2026-02'))[2][1]).toBe('paid');
		expect(await withTenant(sys(), (tx) => mealDue(tx, catAccess))).toBe(0);
		expect(await pay(catBill, '1')).toBe('not_payable');
		await withTenant(sys(), (tx) =>
			tx.update(memberships).set({ employeeId: ids.ana }).where(eq(memberships.userId, who.ana.user.userId))
		);
		const [anaFeb] = await bills('2026-02');
		expect(await pay(anaFeb[4] as string, '1')).toBe('not_payable');
		expect(await code(addFiles(who.mm, 'meal_bill', anaFeb[4] as string, [pdf('x.pdf')]))).toBe('forbidden');
		await withTenant(sys(), (tx) =>
			tx
				.update(mealBills)
				.set({ billingMode: 'direct' })
				.where(and(eq(mealBills.employeeId, ids.ana), eq(mealBills.status, 'draft')))
		);
		expect(await withTenant(sys(), (tx) => mealDue(tx, who.ana.access))).toBe(0);

		const feb = await withTenant(sys(), (tx) => mealStatement(tx, '2026-02'));
		const plates = 18 + 1 + 19 - 1 + 8;
		const guests = 2 + 1;
		expect(feb.rows.map((r) => [r.vendor, r.meal, r.unitCost, r.plates, r.guests])).toEqual([
			['Rice Bowl', 'Lunch', 8051, plates, guests]
		]);
		expect(feb).toMatchObject({
			cost: (plates + guests) * 8051,
			staff: plates * 4026 + guests * 8051,
			company: plates * (8051 - 4026)
		});
		expect(await withTenant(sys(), (tx) => mealStatement(tx, '2026-04'))).toEqual({
			rows: [],
			cost: 0,
			staff: 0,
			company: 0
		});
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
		expect(await code(openBillPdf(narrow, feb[0][4] as string))).toBe('not_found');
		expect(
			await code(
				recordPayment(narrow, {
					billId: feb[2][4] as string,
					amount: '1',
					paidOn: '2026-03-05',
					method: 'cash',
					note: ''
				})
			)
		).toBe('not_found');
		const view = await withTenant(sys(), (tx) => periodBills(tx, narrow.access, '2026-02'));
		expect(view).toMatchObject({ canRun: false, bills: [] });
		expect((await withTenant(sys(), (tx) => periodBills(tx, who.mm.access, '2026-02'))).bills).toHaveLength(3);
	});
});
