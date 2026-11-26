import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { leaveTypes, memberships, tenantSettings } from '../../src/lib/server/db/schema';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { accrue, adjustLeave, leaveHistory, leaveRule, ownBalances } from '../../src/lib/server/leave';
import { decideLeave, requestLeave } from '../../src/lib/server/leave-requests';
import { DEFAULT_LEAVE_TYPES } from '../../src/lib/server/leave-types';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const who: Record<string, Member> = {};
const emp: Record<string, string> = {};
const type: Record<string, string> = {};
const today = dateIn(new Date(), TEST_LOCALE.timezone);
const sys = () => systemCtx(tenant.id);
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const work = (from: string) => {
	let d = from;
	while (TEST_LOCALE.weekendDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
	return d;
};

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

const ask = async (key: string, code: string, startDate: string, files: File[] = []) => {
	await requestLeave(who[key], { leaveTypeId: type[code], startDate, endDate: '', session: 'full', reason: '' }, files);
	const [r] = await ownerPool().sql<{ id: string }[]>`
		select id from leave_requests where employee_id = ${emp[key]} order by created_at desc limit 1`;
	return r.id;
};

async function ledgerTruth(employeeId: string, fy: number) {
	const sums = await ownerPool().sql<{ type: string; days: string }[]>`
		select leave_type_id as type, sum(days) as days from leave_ledger
		where employee_id = ${employeeId} and fiscal_year = ${fy} group by leave_type_id`;
	const held = await ownerPool().sql<{ type: string; pending: string; booked: string }[]>`
		select r.leave_type_id as type,
			sum(case when d.status = 'pending' then case when d.session = 'full' then 1 else 0.5 end else 0 end) as pending,
			sum(case when d.status = 'approved' and d.date > ${today} then case when d.session = 'full' then 1 else 0.5 end else 0 end) as booked
		from leave_request_days d join leave_requests r on r.id = d.request_id
		where d.employee_id = ${employeeId} and d.fiscal_year = ${fy} group by r.leave_type_id`;
	return (id: string) => {
		const balance = Number(sums.find((s) => s.type === id)?.days ?? 0);
		const h = held.find((s) => s.type === id);
		const pending = Number(h?.pending ?? 0);
		return { balance, pending, booked: Number(h?.booked ?? 0), available: balance - pending };
	};
}

beforeAll(async () => {
	tenant = await createTenant('leavecard');
	await withTenant(sys(), async (tx) => {
		await seedTenant(tx, tenant.id, TEST_LOCALE);
		await tx.update(tenantSettings).set({ fiscalYearStartMonth: Number(today.slice(5, 7)) });
		for (const t of await tx.select().from(leaveTypes)) type[t.code] = t.id;
	});
	const hire = (fullName: string, gender: string) =>
		createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
			...blanks,
			fullName,
			gender,
			employmentType: 'full_time',
			status: 'active',
			joinDate: addDays(today, -400)
		});
	emp.ana = await hire('Ca Ana', 'female');
	emp.ben = await hire('Ca Ben', 'male');
	await member('ana', [], emp.ana);
	await member('ben', [], emp.ben);
	await member('hr', ['hr_admin'], null);
	await withTenant(sys(), (tx) => accrue(tx, tenant.id));

	await adjustLeave(who.hr, emp.ana, { leaveTypeId: type.casual, days: '2', note: 'Worked a launch weekend' });
	const first = work(addDays(today, 10));
	const booked = await ask('ana', 'casual', first, [new File(['%PDF-1.7 note'], 'note.pdf')]);
	await decideLeave(who.hr, booked, { decision: 'approve', note: '' });
	await ask('ana', 'casual', work(addDays(first, 1)));
	await ask('ana', 'sick', work(addDays(first, 3)));
	const back = await ask('ben', 'sick', work(addDays(today, 12)));
	await decideLeave(who.hr, back, { decision: 'approve', note: '' });
});

afterAll(closePools);

describe('leave policy cards', () => {
	it('match the leave ledger for every seeded type that applies', async () => {
		const seen = await Promise.all(
			['ana', 'ben'].map(async (key) => {
				const { fy, rows } = await withTenant(sys(), (tx) => ownBalances(tx, who[key].access));
				const history = await withTenant(sys(), (tx) => leaveHistory(tx, emp[key], fy));
				const truth = await ledgerTruth(emp[key], fy);
				return { key, rows, history, truth };
			})
		);
		for (const { key, rows, history, truth } of seen) {
			const gender = key === 'ana' ? 'female' : 'male';
			expect(rows.map((r) => r.name).sort()).toEqual(
				DEFAULT_LEAVE_TYPES.filter((t) => !t.gender || t.gender === gender)
					.map((t) => t.name)
					.sort()
			);
			for (const r of rows) {
				expect({ name: r.name, ...truth(r.id) }).toEqual({
					name: r.name,
					balance: r.balance,
					pending: r.pending,
					booked: r.booked,
					available: r.available
				});
				const oldestFirst = history.filter((h) => h.leaveTypeId === r.id).reverse();
				let running = 0;
				expect(oldestFirst.map((h) => (running += h.days))).toEqual(oldestFirst.map((h) => h.after));
				expect(oldestFirst.at(-1)?.after ?? 0).toBe(r.balance);
			}
		}
		const earned = seen[0].history.filter((h) => h.leaveTypeId === type.earned);
		expect(earned.at(-1)?.kind).toBe('carry');
		const ana = seen[0].rows;
		const casual = ana.find((r) => r.name === 'Casual leave')!;
		expect([casual.balance, casual.booked, casual.pending, casual.available]).toEqual([11, 1, 1, 10]);
		expect(ana.find((r) => r.name === 'Sick leave')!.pending).toBe(1);
	});

	it('explain each rule in words', async () => {
		const { rows } = await withTenant(sys(), (tx) => ownBalances(tx, who.ana.access));
		const rule = (name: string) => rows.find((r) => r.name === name)!.rule;
		expect(rule('Casual leave')).toBe(
			'10 days a year, added at the start of the year, less for people who join mid-year. Unused days lapse at year end.'
		);
		expect(rule('Earned leave')).toBe(
			'18 days a year, added month by month, less for people who join mid-year. Up to 60 days carry over.'
		);
		expect(rule('Maternity leave')).toBe(
			'112 days a year, added at the start of the year. Unused days lapse at year end.'
		);
		expect(rule('Compensatory leave')).toBe('Earned by working on a weekend or holiday.');
		expect(rule('Unpaid leave')).toBe('No limit. Unpaid.');
		const [casual] = await withTenant(sys(), (tx) => tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'casual')));
		expect(leaveRule({ ...casual, quota: null, accrual: 'yearly' })).toBe('Added by HR.');
	});

	it('list the history newest first with the balance after each entry and its files', async () => {
		const { fy } = await withTenant(sys(), (tx) => ownBalances(tx, who.ana.access));
		const casual = (await withTenant(sys(), (tx) => leaveHistory(tx, emp.ana, fy))).filter(
			(h) => h.leaveTypeId === type.casual
		);
		expect(casual.map((h) => [h.kind, h.days, h.after])).toEqual([
			['taken', -1, 11],
			['adjustment', 2, 12],
			['accrual', 10, 10]
		]);
		expect(casual[0]).toMatchObject({ files: 1, from: casual[0].to });
		expect(casual[0].requestId).toBeTruthy();
		expect(casual[1]).toMatchObject({ note: 'Worked a launch weekend', files: 0, requestId: null });
		expect(casual[2].on).toBe(today);
	});
});
