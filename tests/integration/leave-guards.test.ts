import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { leaveTypes, memberships, tenantSettings } from '../../src/lib/server/db/schema';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { adjustLeave, ownBalances } from '../../src/lib/server/leave';
import { decideLeave, requestLeave } from '../../src/lib/server/leave-requests';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const type: Record<string, string> = {};
const today = dateIn(new Date(), 'Asia/Dhaka');
const month = Number(today.slice(5, 7));
const sys = () => systemCtx(tenant.id);
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const work = (from: string) => {
	let d = from;
	while (weekday(d) === 5 || weekday(d) === 6) d = addDays(d, 1);
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

beforeAll(async () => {
	tenant = await createTenant('leaveguard');
	await withTenant(sys(), async (tx) => {
		await seedTenant(tx, tenant.id);
		await tx.update(tenantSettings).set({ fiscalYearStartMonth: month });
		for (const t of await tx.select().from(leaveTypes)) type[t.code] = t.id;
	});
	ids.worker = await createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName: 'Wo Worker',
		employmentType: 'full_time',
		status: 'active',
		gender: 'male',
		joinDate: addDays(today, -400)
	});
	await member('worker', [], ids.worker);
	await member('hr', ['hr_admin'], null);
});

afterAll(closePools);

const balance = async () => {
	const { rows } = await withTenant(sys(), (tx) => ownBalances(tx, who.worker.access));
	const b = rows.find((r) => r.name.toLowerCase().includes('casual'))!;
	return { balance: b.balance, pending: b.pending, available: b.available };
};

describe('leave balance never goes below zero', () => {
	it('refuses an approval or an adjustment the balance cannot cover', async () => {
		const before = await balance();
		await requestLeave(who.worker, {
			leaveTypeId: type.casual,
			startDate: work(addDays(today, 14)),
			endDate: '',
			session: 'full',
			reason: ''
		});
		await expect(
			adjustLeave(who.hr, ids.worker, { leaveTypeId: type.casual, days: String(-before.balance - 1), note: 'too far' })
		).rejects.toMatchObject({ code: 'negative_balance' });
		await adjustLeave(who.hr, ids.worker, { leaveTypeId: type.casual, days: String(-before.balance), note: 'zero it' });
		const [req] = await withTenant(sys(), (tx) =>
			tx.query.leaveRequests.findMany({ where: (t, { eq }) => eq(t.employeeId, ids.worker) })
		);
		await expect(decideLeave(who.hr, req.id, { decision: 'approve', note: '' })).rejects.toMatchObject({
			code: 'insufficient'
		});
		expect(await balance()).toEqual({ balance: 0, pending: 1, available: -1 });
		await adjustLeave(who.hr, ids.worker, { leaveTypeId: type.casual, days: '1', note: 'top up' });
		await decideLeave(who.hr, req.id, { decision: 'approve', note: '' });
		expect(await balance()).toEqual({ balance: 0, pending: 0, available: 0 });
	});
});
