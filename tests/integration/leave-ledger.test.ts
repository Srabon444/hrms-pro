import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { employees, leaveLedger, leaveTypes, memberships, tenantSettings } from '../../src/lib/server/db/schema';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { accrue, adjustLeave, importLeaveBalances, leaveBalances, runLeaveAccrual } from '../../src/lib/server/leave';
import { listLeaveTypes, updateLeaveType } from '../../src/lib/server/leave-types';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
let other: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const today = dateIn(new Date(), 'Asia/Dhaka');
const month = Number(today.slice(5, 7));
const sys = (id = tenant.id) => systemCtx(id);
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
const hire = (fullName: string, extra: Record<string, string> = {}, t = tenant) =>
	createEmployee({ tenantId: t.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		gender: 'male',
		joinDate: addDays(today, -800),
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

const view = (key: string, employeeId: string, gender: string | null = 'male') =>
	withTenant(sys(), (tx) => leaveBalances(tx, who[key].access, { id: employeeId, gender }));
const balances = async (employeeId: string, gender: string | null = 'male') =>
	Object.fromEntries(
		(await withTenant(sys(), (tx) => leaveBalances(tx, who.hr.access, { id: employeeId, gender })))!.rows.map((r) => [
			r.name,
			r.unlimited ? 'unlimited' : r.balance
		])
	);
const ledger = (employeeId: string) =>
	withTenant(sys(), async (tx) =>
		(
			await tx
				.select({ code: leaveTypes.code, kind: leaveLedger.kind, fy: leaveLedger.fiscalYear, days: leaveLedger.days })
				.from(leaveLedger)
				.innerJoin(leaveTypes, eq(leaveTypes.id, leaveLedger.leaveTypeId))
				.where(eq(leaveLedger.employeeId, employeeId))
		).map((r) => `${r.code} ${r.kind} ${r.fy} ${r.days}`)
	);
const fy = Number(today.slice(0, 4));
const typeId = async (code: string) => (await withTenant(sys(), listLeaveTypes)).find((t) => t.code === code)!;
const typeForm = (t: Awaited<ReturnType<typeof typeId>>, extra: Record<string, string>) => ({
	name: t.name,
	quota: t.quota === null ? '' : String(t.quota),
	accrual: t.accrual,
	carryCap: String(t.carryCap),
	maxConsecutive: '',
	minNoticeDays: String(t.minNoticeDays),
	gender: t.gender ?? '',
	...(t.paid ? { paid: 'on' } : {}),
	...(t.proRata ? { proRata: 'on' } : {}),
	halfDayAllowed: 'on',
	active: 'on',
	...extra
});

beforeAll(async () => {
	tenant = await createTenant('ledger');
	other = await createTenant('ledger-other');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	await withTenant(sys(other.id), (tx) => seedTenant(tx, other.id));
	await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ fiscalYearStartMonth: month }));
	await updateLeaveType(
		{ tenantId: tenant.id, actor: 'user' },
		(await typeId('casual')).id,
		typeForm(await typeId('casual'), { carryCap: '3' })
	);
	ids.vet = await hire('Ve Veteran');
	ids.hrEmp = await hire('Ha HR');
	ids.stranger = await hire('St Stranger');
	await member('hr', ['hr_admin'], ids.hrEmp);
	await member('vet', [], ids.vet);
	await member('stranger', [], ids.stranger);
});

afterAll(closePools);

describe('leave ledger', () => {
	it('credits last year, rolls it over within the carry caps, then credits this year', async () => {
		expect(await balances(ids.vet)).toEqual({
			'Casual leave': 13,
			'Compensatory leave': 0,
			'Earned leave': 19.5,
			'Paternity leave': 5,
			'Sick leave': 14,
			'Unpaid leave': 'unlimited'
		});
		const rows = await ledger(ids.vet);
		for (const r of [
			`casual accrual ${fy - 1} 10`,
			`casual expiry ${fy - 1} -7`,
			`casual carry ${fy} 3`,
			`sick expiry ${fy - 1} -14`,
			`paternity expiry ${fy - 1} -5`,
			`earned carry ${fy} 18`
		])
			expect(rows).toContain(r);
		expect(rows.filter((r) => r.startsWith('earned accrual'))).toHaveLength(13);
		expect(rows.some((r) => r.startsWith('maternity'))).toBe(false);
		expect(rows.some((r) => r.startsWith('earned expiry'))).toBe(false);
		await withTenant(sys(), (tx) => accrue(tx, tenant.id));
		expect(await ledger(ids.vet)).toHaveLength(rows.length);
		expect((await balances(ids.vet))['Earned leave']).toBe(19.5);
		expect((await balances(ids.vet))['Casual leave']).toBe(13);
	});

	it('credits a joiner from the join month, by gender, and nobody before they join', async () => {
		ids.joiner = await hire('Jo Joiner', { gender: 'female', status: 'onboarding', joinDate: today });
		expect(await balances(ids.joiner, 'female')).toEqual({
			'Casual leave': 10,
			'Compensatory leave': 0,
			'Earned leave': 1.5,
			'Maternity leave': 112,
			'Sick leave': 14,
			'Unpaid leave': 'unlimited'
		});
		ids.future = await hire('Fu Future', { status: 'onboarding', joinDate: addDays(today, 10) });
		expect((await balances(ids.future))['Casual leave']).toBe(0);
		const sick = await typeId('sick');
		await updateLeaveType({ tenantId: tenant.id, actor: 'user' }, sick.id, { ...typeForm(sick, {}), active: '' });
		ids.late = await hire('La Late', { joinDate: addDays(today, -1) });
		expect((await ledger(ids.late)).some((r) => r.startsWith('sick'))).toBe(false);
		const halfway = new Date(Date.UTC(fy - 1, month - 1 + 6, 15)).toISOString().slice(0, 10);
		ids.mid = await hire('Mi Mid', { joinDate: halfway });
		expect(await ledger(ids.mid)).toContain(`casual accrual ${fy - 1} 5`);
		expect(await ledger(ids.mid)).toContain(`paternity accrual ${fy - 1} 5`);
		await withTenant(sys(), async (tx) => {
			await tx.update(employees).set({ status: 'exited', exitDate: today }).where(eq(employees.id, ids.mid));
			await tx.delete(leaveLedger).where(eq(leaveLedger.employeeId, ids.mid));
			await accrue(tx, tenant.id);
		});
		expect(await ledger(ids.mid)).toEqual([]);
		await updateLeaveType({ tenantId: tenant.id, actor: 'user' }, sick.id, typeForm(sick, {}));
	});

	it('shows balances to the person and HR, and lets only HR adjust someone else', async () => {
		expect(await view('stranger', ids.vet)).toBeNull();
		expect((await view('vet', ids.vet))?.canAdjust).toBe(false);
		expect((await view('hr', ids.vet))?.canAdjust).toBe(true);
		expect((await view('hr', ids.hrEmp))?.canAdjust).toBe(false);
		const casual = (await typeId('casual')).id;
		const form = (extra: Record<string, string> = {}) => ({
			leaveTypeId: casual,
			days: '2',
			note: 'Worked Eid',
			...extra
		});
		expect(await code(adjustLeave(who.stranger, ids.vet, form()))).toBe('not_found');
		expect(await code(adjustLeave(who.vet, ids.vet, form()))).toBe('forbidden');
		expect(await code(adjustLeave(who.hr, ids.hrEmp, form()))).toBe('self_change');
		expect(await code(adjustLeave(who.hr, ids.vet, form({ days: '0.3' })))).toBe('invalid');
		expect(await code(adjustLeave(who.hr, ids.vet, form({ days: '0' })))).toBe('invalid');
		expect(await code(adjustLeave(who.hr, ids.vet, form({ note: ' ' })))).toBe('invalid');
		expect(await code(adjustLeave(who.hr, ids.vet, form({ leaveTypeId: (await typeId('maternity')).id })))).toBe(
			'unknown_type'
		);
		expect(await code(adjustLeave(who.hr, ids.vet, form({ leaveTypeId: crypto.randomUUID() })))).toBe('unknown_type');
		expect(await code(adjustLeave(who.hr, ids.vet, form()))).toBe('ok');
		expect(await code(adjustLeave(who.hr, ids.vet, form({ days: '-0.5' })))).toBe('ok');
		expect((await balances(ids.vet))['Casual leave']).toBe(14.5);
	});

	it('sets opening balances from a file and changes nothing on a second import', async () => {
		const codeOf = async (id: string) =>
			(await withTenant(sys(), (tx) => tx.select().from(employees).where(eq(employees.id, id))))[0].code;
		const [vet, self, stranger] = await Promise.all([ids.vet, ids.hrEmp, ids.stranger].map(codeOf));
		const header = ['employee_code', 'leave_type_code', 'balance', 'note'];
		const file = [
			header,
			[vet, 'casual', '10', 'Opening balance'],
			[vet, 'sick', '7.5', 'Opening balance'],
			[stranger, 'casual', '0', 'Opening balance']
		];
		expect(await importLeaveBalances(who.hr, file)).toBe(3);
		expect(await importLeaveBalances(who.hr, file)).toBe(0);
		expect(await balances(ids.vet)).toMatchObject({ 'Casual leave': 10, 'Sick leave': 7.5 });
		expect((await balances(ids.stranger))['Casual leave']).toBe(0);
		const rows = (key: string, body: string[][]) =>
			importLeaveBalances(who[key], [header, ...body]).catch((e: { rows?: unknown }) => e.rows);
		expect(
			await rows('hr', [
				[self, 'casual', '5', 'x'],
				['NOPE-1', 'casual', '5', 'x'],
				[vet, 'maternity', '5', 'x'],
				[vet, 'unpaid', '5', 'x'],
				[vet, 'nope', '5', 'x'],
				[vet, 'casual', '2.3', 'x'],
				[vet, 'casual', '-1', 'x'],
				[vet, 'casual', '400', 'x'],
				[vet, 'casual', '', 'x'],
				[vet, 'sick', '3', ' '],
				[stranger, 'sick', '3', 'x'],
				[stranger, 'sick', '4', 'x']
			])
		).toEqual([
			{ line: 2, message: 'Someone else has to adjust your own leave.' },
			{ line: 3, message: 'No employee has this code.' },
			{ line: 4, message: 'Choose a leave type that applies.' },
			{ line: 5, message: 'Unpaid leave has no balance to set.' },
			{ line: 6, message: 'Choose a leave type that applies.' },
			{ line: 7, message: 'Use whole or half days from 0 to 366.' },
			{ line: 8, message: 'Use whole or half days from 0 to 366.' },
			{ line: 9, message: 'Use whole or half days from 0 to 366.' },
			{ line: 10, message: 'Use whole or half days from 0 to 366.' },
			{ line: 11, message: 'Say why the balance changes.' },
			{ line: 13, message: 'This person and leave type appear twice in the file.' }
		]);
		expect(await rows('vet', [[vet, 'casual', '20', 'x']])).toEqual([
			{ line: 2, message: 'You cannot adjust leave for this person.' }
		]);
		expect(await balances(ids.vet)).toMatchObject({ 'Casual leave': 10, 'Sick leave': 7.5 });
		expect((await balances(ids.stranger))['Sick leave']).not.toBe(3);
	});

	it('runs the accrual job for every tenant', async () => {
		const outsider = await hire('Ou Outsider', {}, other);
		const credited = () =>
			withTenant(
				sys(other.id),
				async (tx) => (await tx.select().from(leaveLedger).where(eq(leaveLedger.employeeId, outsider))).length
			);
		expect(await credited()).toBeGreaterThan(0);
		await withTenant(sys(other.id), (tx) => tx.delete(leaveLedger).where(eq(leaveLedger.employeeId, outsider)));
		expect(await credited()).toBe(0);
		await runLeaveAccrual();
		expect(await credited()).toBeGreaterThan(0);
	});
});
