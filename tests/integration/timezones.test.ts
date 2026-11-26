import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceMonth, importPunches, punch, recomputeAttendance } from '../../src/lib/server/attendance';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import { attendanceDays, attendancePunches, branches, employees, memberships } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addOrgItem, updateOrgItem } from '../../src/lib/server/org';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const ctx = () => ({ tenantId: tenant.id, actor: 'user' as const });
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
const hire = (fullName: string, branchId: string) =>
	createEmployee(ctx(), creator as never, {
		...blanks,
		fullName,
		branchId,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01'
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

const rows = (employeeId: string) =>
	withTenant(sys(), async (tx) =>
		Object.fromEntries(
			(
				await tx
					.select()
					.from(attendanceDays)
					.where(eq(attendanceDays.employeeId, employeeId))
					.orderBy(asc(attendanceDays.date))
			).map((d) => [d.date, { zone: d.timeZone, firstIn: d.firstIn?.toISOString() ?? null, status: d.status }])
		)
	);
const codeOf = (id: string) =>
	withTenant(sys(), async (tx) => (await tx.select().from(employees).where(eq(employees.id, id)))[0].code);

beforeAll(async () => {
	tenant = await createTenant('zones');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.home = await addOrgItem(ctx(), 'branch', { name: 'Dhaka HQ' });
	ids.gulf = await addOrgItem(ctx(), 'branch', { name: 'Dubai', timezone: 'Asia/Dubai' });
	ids.york = await addOrgItem(ctx(), 'branch', { name: 'New York', timezone: 'America/New_York' });
	ids.dhaka = await hire('Dhaka Person', ids.home);
	ids.dubai = await hire('Dubai Person', ids.gulf);
	ids.hr = await hire('HR', ids.home);
	await member('hr', ['hr_admin'], ids.hr);
	await member('dhaka', ['employee'], ids.dhaka);
	await member('dubai', ['employee'], ids.dubai);
});

afterAll(closePools);

describe('branch time zones', () => {
	it('accepts only real IANA zone names for a branch', async () => {
		expect(await code(addOrgItem(ctx(), 'branch', { name: 'Bad', timezone: '+06:00' }))).toBe('invalid');
		expect(await code(addOrgItem(ctx(), 'branch', { name: 'Bad', timezone: 'asia/dubai' }))).toBe('invalid');
		expect(await code(addOrgItem(ctx(), 'branch', { name: 'Ship', timezone: 'UTC' }))).toBe('ok');
		const id = await addOrgItem(ctx(), 'branch', { name: 'London', timezone: 'Europe/London' });
		await updateOrgItem(ctx(), 'branch', id, { name: 'London', timezone: '' });
		const [b] = await withTenant(sys(), (tx) => tx.select().from(branches).where(eq(branches.id, id)));
		expect(b.timezone).toBeNull();
	});

	it("reads device stamps in each person's branch zone and keeps the zone on the day", async () => {
		const result = await withTestNow('2026-11-23T02:00:00Z', async () =>
			importPunches(who.hr, [
				['employee_code', 'timestamp'],
				[await codeOf(ids.dhaka), '2026-11-22 09:00'],
				[await codeOf(ids.dubai), '2026-11-22 09:00'],
				[await codeOf(ids.dubai), '2026-11-23 04:30']
			])
		);
		expect(result).toEqual({ added: 3, skipped: 0 });
		const stamps = await withTenant(sys(), (tx) =>
			tx
				.select({ employeeId: attendancePunches.employeeId, at: attendancePunches.at })
				.from(attendancePunches)
				.orderBy(asc(attendancePunches.at))
		);
		expect(stamps.map((s) => [s.employeeId, s.at.toISOString()])).toEqual([
			[ids.dhaka, '2026-11-22T03:00:00.000Z'],
			[ids.dubai, '2026-11-22T05:00:00.000Z'],
			[ids.dubai, '2026-11-23T00:30:00.000Z']
		]);
		expect((await rows(ids.dhaka))['2026-11-22']).toMatchObject({
			zone: 'Asia/Dhaka',
			firstIn: '2026-11-22T03:00:00.000Z'
		});
		const gulf = await rows(ids.dubai);
		expect(gulf['2026-11-22']).toEqual({ zone: 'Asia/Dubai', firstIn: '2026-11-22T05:00:00.000Z', status: 'present' });
		expect(gulf['2026-11-23']).toBeUndefined();
		const month = await withTenant(sys(), (tx) => attendanceMonth(tx, who.hr.access, ids.dubai, '2026-11'));
		expect(month?.timeZone).toBe('Asia/Dubai');
	});

	it('keeps past days in their zone after the branch moves and counts no punch twice', async () => {
		await updateOrgItem(ctx(), 'branch', ids.gulf, { name: 'Dubai', timezone: 'Asia/Dhaka' });
		await withTestNow('2026-11-24T12:00:00Z', () =>
			withTenant(sys(), (tx) => recomputeAttendance(tx, tenant.id, '2026-11-22', '2026-11-24', [ids.dubai]))
		);
		const after = await rows(ids.dubai);
		expect(after['2026-11-22']).toMatchObject({ zone: 'Asia/Dubai', firstIn: '2026-11-22T05:00:00.000Z' });
		expect(after['2026-11-23']).toMatchObject({ zone: 'Asia/Dhaka', firstIn: '2026-11-23T00:30:00.000Z' });
		expect(after['2026-11-24']).toMatchObject({ zone: 'Asia/Dhaka' });
		await updateOrgItem(ctx(), 'branch', ids.gulf, { name: 'Dubai', timezone: 'Asia/Dubai' });
	});

	it('moves a person west without losing the punch that falls between the two zones', async () => {
		const id = await hire('Westward', ids.home);
		await withTestNow('2026-11-23T12:00:00Z', () =>
			withTenant(sys(), (tx) => recomputeAttendance(tx, tenant.id, '2026-11-22', '2026-11-23', [id]))
		);
		await withTenant(sys(), (tx) => tx.update(employees).set({ branchId: ids.york }).where(eq(employees.id, id)));
		await withTestNow('2026-11-24T20:00:00Z', async () =>
			importPunches(who.hr, [
				['employee_code', 'timestamp'],
				[await codeOf(id), '2026-11-24T02:00:00+00:00']
			])
		);
		const seen = Object.values(await rows(id)).filter((d) => d.firstIn === '2026-11-24T02:00:00.000Z');
		expect(seen).toHaveLength(1);
	});

	it('gives an on-time punch after a move east to the new day, not the old one', async () => {
		const id = await hire('Eastward', ids.york);
		await withTestNow('2026-11-24T01:00:00Z', () =>
			withTenant(sys(), (tx) => recomputeAttendance(tx, tenant.id, '2026-11-22', '2026-11-23', [id]))
		);
		await withTenant(sys(), (tx) => tx.update(employees).set({ branchId: ids.home }).where(eq(employees.id, id)));
		await withTestNow('2026-11-24T15:00:00Z', async () =>
			importPunches(who.hr, [
				['employee_code', 'timestamp'],
				[await codeOf(id), '2026-11-24T02:00:00+00:00']
			])
		);
		const after = await rows(id);
		expect(after['2026-11-23']).toMatchObject({ zone: 'America/New_York', firstIn: null });
		expect(after['2026-11-24']).toMatchObject({ zone: 'Asia/Dhaka', firstIn: '2026-11-24T02:00:00.000Z' });
	});

	it('puts the same instant on different days for people in different zones', async () => {
		await withTestNow('2026-11-25T23:30:00Z', async () => {
			expect(await code(punch(who.dhaka, null))).toBe('ok');
			expect(await code(punch(who.dubai, null))).toBe('ok');
		});
		const day = async (employeeId: string, date: string) =>
			withTenant(sys(), async (tx) => {
				const [d] = await tx
					.select({ firstIn: attendanceDays.firstIn })
					.from(attendanceDays)
					.where(and(eq(attendanceDays.employeeId, employeeId), eq(attendanceDays.date, date)));
				return d?.firstIn?.toISOString() ?? null;
			});
		expect(await day(ids.dhaka, '2026-11-26')).toBe('2026-11-25T23:30:00.000Z');
		expect(await day(ids.dubai, '2026-11-25')).toBe('2026-11-25T23:30:00.000Z');
		expect(await day(ids.dubai, '2026-11-26')).toBeNull();
	});
});
