import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { employees, memberships } from '../../src/lib/server/db/schema';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import {
	assignShift,
	createShift,
	employeeShift,
	listShifts,
	removeShiftAssignment,
	shiftFor,
	updateShift
} from '../../src/lib/server/shifts';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
let other: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const today = dateIn(new Date(), 'Asia/Dhaka');
const sys = (id = tenant.id) => systemCtx(id);
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
const hire = (fullName: string, extra: Record<string, string> = {}) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: addDays(today, -100),
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

const form = (extra: Record<string, string> = {}) => ({
	name: 'Night',
	startTime: '22:00',
	endTime: '06:00',
	graceMinutes: '10',
	halfDayMinutes: '240',
	fullDayMinutes: '420',
	active: 'on',
	...extra
});
const shifts = (id = tenant.id) => withTenant(sys(id), listShifts);
const byName = async (name: string) => (await shifts()).find((s) => s.name === name)!;
const current = (employeeId: string, date: string) => withTenant(sys(), (tx) => shiftFor(tx, employeeId, date));

beforeAll(async () => {
	tenant = await createTenant('shifts');
	other = await createTenant('shifts-other');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(sys(other.id), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	ids.boss = await hire('Boss');
	ids.staff = await hire('Staff', { managerId: ids.boss });
	ids.peer = await hire('Peer');
	ids.hr = await hire('HR');
	ids.fresh = await hire('Fresh', { joinDate: addDays(today, 10), status: 'onboarding' });
	await member('hr', ['hr_admin'], ids.hr);
	await member('boss', ['line_manager'], ids.boss);
	await member('staff', ['employee'], ids.staff);
});

afterAll(closePools);

describe('shifts', () => {
	it('seeds one active default shift per tenant', async () => {
		await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
		expect((await shifts()).map((s) => [s.name, s.startTime, s.endTime, s.isDefault, s.active])).toEqual([
			['General', '09:00:00', '18:00:00', true, true]
		]);
		expect((await current(ids.staff, today))?.name).toBe('General');
	});

	it('validates shifts and keeps exactly one active default', async () => {
		expect(await code(createShift(ctx(), form()))).toBe('ok');
		expect(await code(createShift(ctx(), form()))).toBe('duplicate');
		for (const bad of <Record<string, string>[]>[
			{ name: ' ' },
			{ startTime: '25:00' },
			{ endTime: '22:00' },
			{ graceMinutes: '241' },
			{ halfDayMinutes: '0' },
			{ halfDayMinutes: '500' },
			{ fullDayMinutes: '481' },
			{ fullDayMinutes: '1441' }
		])
			expect(await code(createShift(ctx(), form({ name: 'Bad', ...bad })))).toBe('invalid');
		expect(await code(createShift(ctx(), form({ name: 'Off', isDefault: 'on', active: '' })))).toBe('inactive_default');
		const general = await byName('General');
		expect(
			await code(updateShift(ctx(), general.id, form({ name: 'General', startTime: '09:00', endTime: '18:00' })))
		).toBe('default_required');
		const night = await byName('Night');
		expect(await code(updateShift(ctx(), night.id, form({ isDefault: 'on' })))).toBe('ok');
		expect((await shifts()).filter((s) => s.isDefault).map((s) => s.name)).toEqual(['Night']);
		expect(await code(updateShift(ctx(), night.id, form({ isDefault: 'on', active: '' })))).toBe('inactive_default');
		expect(
			await code(
				updateShift(ctx(), general.id, form({ name: 'General', startTime: '09:00', endTime: '18:00', isDefault: 'on' }))
			)
		).toBe('ok');
		expect(await code(updateShift(ctx(), night.id, form({ name: 'General' })))).toBe('duplicate');
		expect(await code(updateShift(ctx(), crypto.randomUUID(), form()))).toBe('not_found');
		expect(await code(updateShift(ctx(), 'nope', form()))).toBe('not_found');
		expect((await shifts(other.id)).map((s) => s.name)).toEqual(['General']);
	});

	it('assigns shifts from a date with history, scoped to attendance managers', async () => {
		const night = await byName('Night');
		const general = await byName('General');
		const from = addDays(today, 5);
		const assign = (key: string, employeeId: string, shiftId: string, effectiveFrom = from) =>
			code(assignShift(who[key], employeeId, { shiftId, effectiveFrom }));
		expect(await assign('boss', ids.staff, night.id)).toBe('forbidden');
		expect(await assign('staff', ids.staff, night.id)).toBe('forbidden');
		expect(await assign('hr', ids.staff, night.id, addDays(today, -101))).toBe('before_join');
		expect(await assign('hr', ids.staff, crypto.randomUUID())).toBe('unknown_shift');
		expect(await assign('hr', ids.staff, night.id, 'soon')).toBe('invalid');
		expect(await assign('hr', ids.fresh, night.id, today)).toBe('before_join');
		expect(await assign('hr', ids.staff, night.id)).toBe('ok');
		expect(await assign('hr', ids.staff, general.id, addDays(today, -50))).toBe('ok');
		expect((await current(ids.staff, addDays(today, -60)))?.name).toBe('General');
		expect((await current(ids.staff, today))?.name).toBe('General');
		expect((await current(ids.staff, from))?.name).toBe('Night');
		expect(await assign('hr', ids.staff, general.id)).toBe('ok');
		expect((await current(ids.staff, from))?.name).toBe('General');
		expect(await assign('hr', ids.staff, night.id)).toBe('ok');

		const view = (key: string, employeeId: string) =>
			withTenant(sys(), (tx) => employeeShift(tx, who[key].access, { id: employeeId }, from));
		const own = await view('staff', ids.staff);
		expect(own).toMatchObject({ canManage: false, choices: [], current: { name: 'Night' } });
		expect(own!.history.map((h) => [h.effectiveFrom, h.name])).toEqual([
			[from, 'Night'],
			[addDays(today, -50), 'General']
		]);
		expect((await view('boss', ids.staff))?.canManage).toBe(false);
		expect(await view('boss', ids.peer)).toBeNull();
		expect(await view('staff', ids.peer)).toBeNull();
		const hr = await view('hr', ids.staff);
		expect(hr?.canManage).toBe(true);
		expect(hr!.choices.map((c) => c.name)).toEqual(['General', 'Night']);

		const [first] = own!.history;
		expect(await code(removeShiftAssignment(who.boss, ids.staff, first.id))).toBe('forbidden');
		expect(await code(removeShiftAssignment(who.hr, ids.peer, first.id))).toBe('not_found');
		expect(await code(removeShiftAssignment(who.hr, ids.staff, first.id))).toBe('ok');
		expect(await code(removeShiftAssignment(who.hr, ids.staff, first.id))).toBe('not_found');
		expect((await current(ids.staff, from))?.name).toBe('General');

		await withTenant(sys(), (tx) => tx.update(employees).set({ status: 'active' }).where(eq(employees.id, ids.peer)));
		const off = await byName('Night');
		await updateShift(ctx(), off.id, form({ active: '' }));
		expect(await assign('hr', ids.peer, off.id)).toBe('unknown_shift');
		expect((await view('hr', ids.staff))!.choices.map((c) => c.name)).toEqual(['General']);
	});
});
