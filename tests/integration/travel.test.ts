import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODULE_IDS, MODULES } from '../../src/lib/modules';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { expenseCategories, expenseClaims, loans, memberships, travelRequests } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { saveCategory, submitClaim } from '../../src/lib/server/expenses';
import { decideLoan, loanApprovals } from '../../src/lib/server/loans';
import { saveModules } from '../../src/lib/server/modules';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import {
	cancelTrip,
	decideTrip,
	deleteRate,
	requestTrip,
	saveRate,
	travelApprovals,
	travelBoard
} from '../../src/lib/server/travel';
import { createTenant, createUser, TEST_LOCALE } from './helpers';
import { expectScoped, leakWorld } from './leak';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (fullName: string, managerId = '') =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		managerId,
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

const trip = (over: Record<string, string> = {}) => ({
	purpose: 'Client workshop',
	country: 'India',
	city: 'Mumbai',
	departOn: '2027-03-01',
	returnOn: '2027-03-04',
	estimatedCost: '50000',
	advance: '20000',
	...over
});
const tripsOf = (employeeId: string) =>
	withTenant(sys(), (tx) => tx.select().from(travelRequests).where(eq(travelRequests.employeeId, employeeId)));
const board = (key: string) => withTenant(userCtx(who[key]), (tx) => travelBoard(tx, who[key]));
const decide = (key: string, tripId: string, decision = 'approve') =>
	decideTrip(who[key], { tripId, decision, note: '' });
let cat = '';

const modules = (on: boolean) =>
	saveModules(sys(), [...MODULE_IDS.filter((m) => MODULES[m].on), ...(on ? ['travel'] : [])]);

beforeAll(async () => {
	tenant = await createTenant('travel');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.mgr = await hire('Mia');
	ids.ann = await hire('Ann', ids.mgr);
	ids.bob = await hire('Bob');
	ids.fin = await hire('Fin');
	await member('mgr', ['line_manager', 'employee'], ids.mgr);
	await member('ann', ['employee'], ids.ann);
	await member('bob', ['employee'], ids.bob);
	await member('hr', ['hr_admin'], null);
	await member('fin', ['finance', 'employee'], ids.fin);
	await modules(true);
	await saveCategory(who.fin, '', { name: 'Taxi', claimLimit: '', active: 'on' });
	cat = (await withTenant(sys(), (tx) => tx.select().from(expenseCategories)))[0].id;
});

afterAll(closePools);

describe('trip requests', () => {
	it('checks the form on the server', async () => {
		expect(await code(requestTrip(who.ann, trip({ returnOn: '2027-02-27' })))).toBe(
			'invalid: The return date cannot be before departure.'
		);
		expect(await code(requestTrip(who.ann, trip({ advance: '60000' })))).toBe(
			'invalid: The advance cannot be more than the estimated cost.'
		);
		expect(await code(requestTrip(who.ann, trip({ departOn: '2020-01-01', returnOn: '2020-01-02' })))).toBe(
			'past_trip'
		);
		expect(await code(requestTrip(who.ann, trip({ departOn: '2150-01-01', returnOn: '2150-01-02' })))).toBe(
			'invalid: Choose a date between 2000 and 2099.'
		);
		expect(await code(requestTrip(who.ann, trip({ purpose: 'Bad\u0007' })))).toBe(
			'invalid: Remove control characters.'
		);
		expect(await code(requestTrip(who.ann, trip({ estimatedCost: '-5' })))).toMatch(/^invalid/);
		expect(await code(requestTrip(who.hr, trip()))).toBe('no_employee');
		expect(await tripsOf(ids.ann)).toHaveLength(0);
	});

	it('sends the trip to the manager, who alone may decide it', async () => {
		await requestTrip(who.ann, trip());
		const [t] = await tripsOf(ids.ann);
		expect(t).toMatchObject({ status: 'submitted', advance: 2_000_000, estimatedCost: 5_000_000, city: 'Mumbai' });
		const inbox = await withTenant(sys(), (tx) => travelApprovals(tx, who.mgr.access));
		expect(inbox.map((i) => i.id)).toEqual([t.id]);
		expect(await withTenant(sys(), (tx) => travelApprovals(tx, who.bob.access))).toEqual([]);
		expect(await code(decide('ann', t.id))).toBe('not_found');
		expect(await code(decide('bob', t.id))).toBe('not_found');
		expect(await code(decide('fin', t.id))).toBe('forbidden');
	});

	it('turns the advance into a salary advance for finance on approval', async () => {
		const [t] = await tripsOf(ids.ann);
		await decide('mgr', t.id);
		const [after] = await tripsOf(ids.ann);
		expect(after.status).toBe('approved');
		const [loan] = await withTenant(sys(), (tx) => tx.select().from(loans).where(eq(loans.id, after.loanId!)));
		expect(loan).toMatchObject({
			kind: 'advance',
			status: 'requested',
			amount: 2_000_000,
			instalments: 1,
			startPeriod: '2027-03',
			employeeId: ids.ann,
			reason: 'Travel advance: Client workshop'
		});
		expect((await withTenant(sys(), (tx) => loanApprovals(tx, who.fin.access))).map((l) => l.id)).toContain(loan.id);
		expect(await code(decide('mgr', t.id))).toBe('decided');
		expect(await code(cancelTrip(who.ann, { tripId: t.id }))).toBe('decided');
	});

	it('refuses a second advance while one is still with finance', async () => {
		await requestTrip(who.ann, trip({ purpose: 'Second trip', departOn: '2027-05-01', returnOn: '2027-05-02' }));
		const second = (await tripsOf(ids.ann)).find((t) => t.purpose === 'Second trip')!;
		expect(await code(decide('mgr', second.id))).toBe('advance_waiting');
		expect((await tripsOf(ids.ann)).find((t) => t.id === second.id)!.status).toBe('submitted');
		expect(await code(cancelTrip(who.bob, { tripId: second.id }))).toBe('not_found');
		await cancelTrip(who.ann, { tripId: second.id });
		expect((await tripsOf(ids.ann)).find((t) => t.id === second.id)!.status).toBe('cancelled');
	});

	it('approves a trip without an advance and lets a manager reject one', async () => {
		await requestTrip(who.ann, trip({ purpose: 'No advance', advance: '' }));
		await requestTrip(who.ann, trip({ purpose: 'Rejected', advance: '' }));
		const rows = await tripsOf(ids.ann);
		await decide('mgr', rows.find((t) => t.purpose === 'No advance')!.id);
		await decide('mgr', rows.find((t) => t.purpose === 'Rejected')!.id, 'reject');
		const after = await tripsOf(ids.ann);
		expect(after.find((t) => t.purpose === 'No advance')).toMatchObject({ status: 'approved', loanId: null });
		expect(after.find((t) => t.purpose === 'Rejected')!.status).toBe('rejected');
	});
});

describe('per diem rates', () => {
	it('lets travel managers keep one rate per place, ignoring case', async () => {
		expect(await code(saveRate(who.mgr, { country: 'India', city: '', dailyAmount: '2000' }))).toBe('forbidden');
		await saveRate(who.hr, { country: 'India', city: '', dailyAmount: '2000' });
		await saveRate(who.hr, { country: 'India', city: 'Mumbai', dailyAmount: '3000' });
		expect(await code(saveRate(who.hr, { country: 'india', city: '', dailyAmount: '9' }))).toBe('rate_exists');
		expect(await code(saveRate(who.hr, { country: 'INDIA', city: 'mumbai ', dailyAmount: '9' }))).toBe('rate_exists');
		expect(await code(saveRate(who.hr, { country: 'Nepal', city: '', dailyAmount: '0' }))).toMatch(/^invalid/);
		expect(await code(saveRate(who.hr, { country: 'Nepal', city: '', dailyAmount: '1000000' }))).toBe(
			'invalid: Enter a daily amount up to 999999.99.'
		);
		await saveRate(who.hr, { country: 'Japan', city: '', dailyAmount: '999999.99' });
		await deleteRate(who.hr, { rateId: (await board('hr')).rates.find((r) => r.country === 'Japan')!.id });
		await saveRate(who.hr, { country: 'Nepal', city: '', dailyAmount: '1500' });
		const nepal = (await board('hr')).rates.find((r) => r.country === 'Nepal')!;
		expect(await code(deleteRate(who.mgr, { rateId: nepal.id }))).toBe('forbidden');
		await deleteRate(who.hr, { rateId: nepal.id });
		expect((await board('hr')).rates.map((r) => [r.country, r.city])).toEqual([
			['India', null],
			['India', 'Mumbai']
		]);
	});

	it('shows the city rate, the country rate as fallback, and none elsewhere', async () => {
		await requestTrip(who.bob, trip({ purpose: 'Delhi', city: 'delhi', advance: '' }));
		await requestTrip(who.bob, trip({ purpose: 'Paris', country: 'France', city: '', advance: '' }));
		const mine = (await board('bob')).mine;
		expect(mine.find((t) => t.purpose === 'Delhi')!.perDiem).toEqual({
			daily: 200_000,
			days: 4,
			total: 800_000,
			city: false
		});
		expect(mine.find((t) => t.purpose === 'Paris')!.perDiem).toBeNull();
		const ann = (await board('ann')).mine.find((t) => t.purpose === 'Client workshop')!;
		expect(ann.perDiem).toEqual({ daily: 300_000, days: 4, total: 1_200_000, city: true });
	});
});

describe('claims against a trip', () => {
	const claim = (key: string, travelRequestId: string, amount = '15000') =>
		submitClaim(
			who[key],
			{
				title: 'Trip costs',
				travelRequestId,
				'items.0.categoryId': cat,
				'items.0.spentOn': '2026-11-01',
				'items.0.description': 'Taxi',
				'items.0.amount': amount
			},
			new Map()
		);

	it('only links a claim to the claimant’s own approved trip', async () => {
		const rows = await tripsOf(ids.ann);
		const approved = rows.find((t) => t.purpose === 'Client workshop')!;
		const rejected = rows.find((t) => t.purpose === 'Rejected')!;
		expect(await code(claim('bob', approved.id))).toBe('bad_trip');
		expect(await code(claim('ann', rejected.id))).toBe('bad_trip');
		expect(await code(claim('ann', 'not-a-uuid'))).toBe('invalid: Choose one of your approved trips.');
		const id = await claim('ann', approved.id);
		const [c] = await withTenant(sys(), (tx) => tx.select().from(expenseClaims).where(eq(expenseClaims.id, id)));
		expect(c.travelRequestId).toBe(approved.id);
		expect(await claim('ann', '')).toBeTruthy();
	});

	it('settles the claims against the advance until finance rejects it', async () => {
		const workshop = () => board('ann').then((b) => b.mine.find((t) => t.purpose === 'Client workshop')!);
		expect(await workshop()).toMatchObject({ claimed: 1_500_000, advanceStatus: 'requested', settlement: -500_000 });
		const t = await workshop();
		await decideLoan(who.fin, { loanId: t.loanId!, decision: 'reject', note: '' });
		expect(await workshop()).toMatchObject({ advanceStatus: 'rejected', settlement: 1_500_000 });
		const team = await board('mgr');
		expect(team.others.map((r) => r.purpose)).not.toContain('Client workshop');
		const hr = await board('hr');
		expect(hr.others.find((r) => r.purpose === 'Client workshop')!.settlement).toBe(1_500_000);
	});

	it('adds up claims past the 32-bit limit without breaking the page', async () => {
		await requestTrip(who.bob, trip({ purpose: 'Big', advance: '' }));
		const big = (await tripsOf(ids.bob)).find((t) => t.purpose === 'Big')!;
		await withTenant(sys(), (tx) =>
			tx.update(travelRequests).set({ status: 'approved' }).where(eq(travelRequests.id, big.id))
		);
		for (let i = 0; i < 3; i++) await claim('bob', big.id, '9999999.99');
		const row = (await board('bob')).mine.find((t) => t.id === big.id)!;
		expect(row.claimed).toBe(2_999_999_997);
		expect(row.settlement).toBe(2_999_999_997);
	});

	it('hides trips from claims and the inbox when the module is off', async () => {
		await requestTrip(who.ann, trip({ purpose: 'Waiting', advance: '' }));
		await modules(false);
		try {
			expect(await withTenant(sys(), (tx) => travelApprovals(tx, who.mgr.access))).toEqual([]);
			const approved = (await tripsOf(ids.ann)).find((t) => t.purpose === 'No advance')!;
			expect(await code(claim('ann', approved.id))).toBe('bad_trip');
		} finally {
			await modules(true);
		}
	});
});

describe('trip reads stay inside scope and tenant', () => {
	it('lists only trips the viewer may read', async () => {
		const world = await leakWorld(['travel.read']);
		const sql = ownerPool().sql;
		for (const [tenantId, employeeId] of [
			...Object.values(world.emp)
				.filter((e) => e !== world.emp.other)
				.map((e) => [world.a.id, e]),
			[world.b.id, world.emp.other]
		])
			await sql`insert into travel_requests (tenant_id, employee_id, purpose, country, depart_on, return_on, estimated_cost, status, requested_by_user_id)
				values (${tenantId}, ${employeeId}, 'Leak trip', 'India', '2027-01-01', '2027-01-02', 100, 'approved', gen_random_uuid())`;
		await expectScoped(world, async (m) => {
			const b = await withTenant(userCtx(m), (tx) => travelBoard(tx, m));
			return [...b.mine, ...b.toDecide, ...b.others].map((t) => t.employeeId);
		});
	});
});
