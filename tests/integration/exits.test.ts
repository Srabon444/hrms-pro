import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import {
	departments,
	employeeHistory,
	employees,
	membershipRoles,
	memberships,
	notifications,
	roles
} from '../../src/lib/server/db/schema';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { recordExit, rehire, runTenantLifecycle, upcomingExits, withdrawExit } from '../../src/lib/server/exits';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const today = dateIn(new Date(), 'Asia/Dhaka');
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
		joinDate: addDays(today, -400),
		...extra
	});

async function member(key: string, roleKeys: string[], employeeId: string) {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	ids[`${key}Membership`] = id;
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const employee = (id: string) =>
	withTenant(sys(), async (tx) => (await tx.select().from(employees).where(eq(employees.id, id)))[0]);
const membership = (id: string) =>
	withTenant(sys(), async (tx) => (await tx.select().from(memberships).where(eq(memberships.id, id)))[0]);
const roleKeysOf = (membershipId: string) =>
	withTenant(sys(), async (tx) =>
		(
			await tx
				.select({ key: roles.key })
				.from(membershipRoles)
				.innerJoin(roles, eq(roles.id, membershipRoles.roleId))
				.where(eq(membershipRoles.membershipId, membershipId))
		).map((r) => r.key)
	);

beforeAll(async () => {
	tenant = await createTenant('exits');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.boss = await hire('Boss Big');
	ids.leaver = await hire('Lee Leaver', { managerId: ids.boss });
	ids.r1 = await hire('Rae One', { managerId: ids.leaver });
	ids.r2 = await hire('Rio Two', { managerId: ids.leaver });
	ids.hrEmp = await hire('Hara HR');
	ids.officerEmp = await hire('Ofi Officer');
	ids.ownerEmp = await hire('Ona Owner');
	ids.noticed = await hire('Nia Notice');
	await withTenant(sys(), (tx) =>
		tx.insert(departments).values({ tenantId: tenant.id, name: 'Ops', headEmployeeId: ids.leaver })
	);
	await member('leaver', ['employee'], ids.leaver);
	await member('hr', ['hr_admin'], ids.hrEmp);
	await member('officer', ['hr_officer'], ids.officerEmp);
	await member('owner', ['owner'], ids.ownerEmp);
	await member('noticed', ['employee'], ids.noticed);
});

afterAll(closePools);

describe('exits', () => {
	it('puts a future exit on notice and lets HR withdraw it', async () => {
		const form = { exitDate: addDays(today, 30), exitType: 'resignation', exitReason: 'Moving abroad' };
		expect(await code(recordExit(who.hr, ids.leaver, form))).toBe('ok');
		expect(await employee(ids.leaver)).toMatchObject({ status: 'notice', exitType: 'resignation' });
		expect((await membership(ids.leaverMembership)).status).toBe('active');
		const list = await withTenant(sys(), (tx) => upcomingExits(tx, who.hr.access));
		expect(list.map((x) => x.fullName)).toEqual(['Lee Leaver']);
		expect(await code(withdrawExit(who.hr, ids.leaver))).toBe('ok');
		expect(await employee(ids.leaver)).toMatchObject({ status: 'active', exitDate: null, exitType: null });
		expect(await code(withdrawExit(who.hr, ids.leaver))).toBe('no_pending_exit');
	});

	it('refuses exits by people without the right or for themselves', async () => {
		const form = { exitDate: today, exitType: 'termination', exitReason: '' };
		expect(await code(recordExit(who.officer, ids.leaver, form))).toBe('forbidden');
		expect(await code(recordExit(who.leaver, ids.leaver, form))).toBe('forbidden');
		expect(await code(recordExit(who.hr, ids.hrEmp, form))).toBe('self_change');
		expect(await code(recordExit(who.hr, ids.leaver, { ...form, exitDate: addDays(today, -500) }))).toBe('before_join');
		expect(await code(recordExit(who.hr, ids.leaver, { ...form, exitType: 'fired' }))).toBe('invalid');
		expect(await code(recordExit(who.hr, ids.ownerEmp, form))).toBe('last_owner');
		expect((await employee(ids.ownerEmp)).status).toBe('active');
	});

	it('completes an exit on or before today at once', async () => {
		const form = { exitDate: today, exitType: 'resignation', exitReason: '' };
		expect(await code(recordExit(who.hr, ids.leaver, form))).toBe('ok');
		expect((await employee(ids.leaver)).status).toBe('exited');
		expect((await employee(ids.r1)).managerId).toBe(ids.boss);
		expect((await employee(ids.r2)).managerId).toBe(ids.boss);
		const moved = await withTenant(sys(), (tx) =>
			tx
				.select()
				.from(employeeHistory)
				.where(and(eq(employeeHistory.employeeId, ids.r1), eq(employeeHistory.field, 'managerId')))
		);
		expect(moved.map((h) => [h.oldValue, h.newValue])).toEqual([
			[expect.stringContaining('Lee Leaver'), expect.stringContaining('Boss Big')]
		]);
		const [ops] = await withTenant(sys(), (tx) => tx.select().from(departments).where(eq(departments.name, 'Ops')));
		expect(ops.headEmployeeId).toBeNull();

		const m = await membership(ids.leaverMembership);
		expect(m.status).toBe('ex_employee');
		const until = await withTenant(sys(), (tx) =>
			tx.execute<{ d: string }>(
				sql`select to_char(ex_access_until at time zone 'Asia/Dhaka', 'YYYY-MM-DD HH24:MI') as d from memberships where id = ${ids.leaverMembership}::uuid`
			)
		);
		expect(until[0].d).toBe(`${addDays(today, 91)} 00:00`);
		expect(await roleKeysOf(ids.leaverMembership)).toEqual([]);
		const access = await loadAccess(tenant.id, { id: m.id, status: m.status, employeeId: ids.leaver });
		expect(access.grants).toEqual({ 'employee.read': ['own'], 'document.read': ['own'], 'payroll.read': ['own'] });

		const told = await withTenant(sys(), (tx) =>
			tx.select().from(notifications).where(eq(notifications.membershipId, ids.hrMembership))
		);
		expect(told.map((n) => n.title)).toEqual([expect.stringContaining('Lee Leaver')]);
		expect(told[0].body).toContain('2 direct reports now report to Boss Big');
		expect(told[0].body).toContain('Ops');
		expect(await code(recordExit(who.hr, ids.leaver, form))).toBe('exited');
	});

	it('completes due exits and ends former-employee access in the scheduled run', async () => {
		await recordExit(who.hr, ids.noticed, { exitDate: addDays(today, 3), exitType: 'contract_end', exitReason: '' });
		await withTenant(sys(), (tx) => tx.update(employees).set({ exitDate: today }).where(eq(employees.id, ids.noticed)));
		await withTenant(sys(), (tx) =>
			tx
				.update(memberships)
				.set({ exAccessUntil: sql`now() - interval '1 minute'` })
				.where(eq(memberships.id, ids.leaverMembership))
		);
		await runTenantLifecycle(tenant);
		expect((await employee(ids.noticed)).status).toBe('exited');
		expect((await membership(ids.noticedMembership)).status).toBe('ex_employee');
		expect((await membership(ids.leaverMembership)).status).toBe('disabled');
		await runTenantLifecycle(tenant);
		expect((await membership(ids.noticedMembership)).status).toBe('ex_employee');
	});

	it('rehires the same record and restores self-service access', async () => {
		expect(await code(rehire(who.hr, ids.boss, { joinDate: today }))).toBe('not_exited');
		expect(await code(rehire(who.hr, ids.leaver, { joinDate: today }))).toBe('before_exit');
		expect(await code(rehire(who.leaver, ids.leaver, { joinDate: addDays(today, 7) }))).toBe('forbidden');
		expect(await code(rehire(who.officer, ids.leaver, { joinDate: addDays(today, 7) }))).toBe('ok');
		expect(await employee(ids.leaver)).toMatchObject({
			status: 'onboarding',
			joinDate: addDays(today, 7),
			exitDate: null,
			exitType: null
		});
		expect(await membership(ids.leaverMembership)).toMatchObject({ status: 'active', exAccessUntil: null });
		expect(await roleKeysOf(ids.leaverMembership)).toEqual(['employee']);
	});
});
