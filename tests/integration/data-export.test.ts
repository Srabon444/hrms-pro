import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../../src/lib/server/csv';
import { exportDataset } from '../../src/lib/server/data-export';
import { addDays } from '../../src/lib/server/dates';
import { closePools } from '../../src/lib/server/db';
import {
	auditLog,
	employees,
	employeeSalaries,
	memberships,
	payrollRuns,
	payslips,
	salaryChanges
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { adjustLeave } from '../../src/lib/server/leave';
import { listLeaveTypes } from '../../src/lib/server/leave-types';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

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
const hire = (fullName: string) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		gender: 'male',
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2025-01-01'
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

const csv = async (key: string, dataset: string, extra: Record<string, string> = {}) =>
	parseCsv(toCsv((await exportDataset(who[key], { dataset, from: '', to: '', ...extra })).rows));
const codeOf = (id: string) =>
	withTenant(sys(), async (tx) => (await tx.select().from(employees).where(eq(employees.id, id)))[0].code);

beforeAll(async () => {
	tenant = await createTenant('export');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.ana = await hire('Ana');
	ids.boss = await hire('Boss');
	await member('owner', ['owner'], ids.boss);
	await member('hr', ['hr_admin'], null);
	who.limited = {
		...who.hr,
		access: { ...who.hr.access, grants: { 'data.export': ['all'], 'employee.read': ['all'] } }
	} as unknown as Member;
	await withTenant({ ...sys(), salaryAll: true, payrollAll: true }, async (tx) => {
		const [c] = await tx
			.insert(salaryChanges)
			.values({
				tenantId: tenant.id,
				employeeId: ids.ana,
				effectiveFrom: '2025-01-01',
				reason: 'Hire',
				status: 'approved',
				lines: [],
				gross: 5_000_050,
				requestedByUserId: who.owner.user.userId
			})
			.returning();
		await tx.insert(employeeSalaries).values({
			tenantId: tenant.id,
			employeeId: ids.ana,
			effectiveFrom: '2025-01-01',
			gross: 5_000_050,
			changeId: c.id
		});
		const [run] = await tx
			.insert(payrollRuns)
			.values({
				tenantId: tenant.id,
				period: '2026-10',
				currency: 'BDT',
				inputsHash: 'x',
				outputHash: 'y',
				computedByUserId: who.owner.user.userId,
				computedAt: new Date()
			})
			.returning();
		await tx.insert(payslips).values({
			tenantId: tenant.id,
			runId: run.id,
			employeeId: ids.ana,
			paidDays: 31,
			gross: 5_000_050,
			deductions: 50,
			net: 5_000_000
		});
	});
});

afterAll(closePools);

describe('data export', () => {
	it('needs data.export and the module permission at scope all', async () => {
		expect(await code(exportDataset(who.hr, { dataset: 'employees', from: '', to: '' }))).toBe('forbidden');
		expect(await code(exportDataset(who.limited, { dataset: 'employees', from: '', to: '' }))).toBe('ok');
		expect(await code(exportDataset(who.limited, { dataset: 'salaries', from: '', to: '' }))).toBe('forbidden');
		expect(await code(exportDataset(who.owner, { dataset: 'nope', from: '', to: '' }))).toBe(
			'invalid: Choose what to export.'
		);
	});

	it('exports employees, salaries and payroll with amounts as plain numbers', async () => {
		const ana = await codeOf(ids.ana);
		const people = await csv('owner', 'employees');
		expect(people[0][0]).toBe('code');
		expect(people.map((r) => r[0])).toContain(ana);
		expect(await csv('owner', 'salaries')).toEqual([
			['employee_code', 'employee_name', 'effective_from', 'effective_to', 'gross'],
			[ana, 'Ana', '2025-01-01', '', '50000.5']
		]);
		const pay = await csv('owner', 'payroll', { from: '2026-10-01', to: '2026-10-31' });
		expect(pay[1]).toEqual(
			expect.arrayContaining(['2026-10', 'regular', 'computed', 'BDT', ana, '50000.5', '0.5', '50000'])
		);
		expect(await csv('owner', 'payroll', { from: '2026-11-01', to: '2026-11-30' })).toHaveLength(1);
	});

	it('exports negative leave days so they import again as numbers', async () => {
		const casual = (await withTenant(sys(), listLeaveTypes)).find((t) => t.code === 'casual')!;
		await adjustLeave(who.owner, ids.ana, { leaveTypeId: casual.id, days: '-2', note: 'Took two days off-book' });
		const today = new Date().toISOString().slice(0, 10);
		const rows = await csv('owner', 'leave', { from: addDays(today, -1), to: addDays(today, 1) });
		const taken = rows.find((r) => r.includes('Took two days off-book'))!;
		expect(taken[rows[0].indexOf('days')]).toBe('-2');
		expect(taken[rows[0].indexOf('leave_type_code')]).toBe('casual');
	});

	it('needs a period of at most 366 days for dated data and records each export in the audit log', async () => {
		expect(await code(exportDataset(who.owner, { dataset: 'attendance', from: '', to: '' }))).toBe(
			'invalid: Enter the start date.'
		);
		expect(await code(exportDataset(who.owner, { dataset: 'attendance', from: '2025-01-01', to: '2026-01-03' }))).toBe(
			'invalid: Export at most 366 days at a time.'
		);
		expect(await code(exportDataset(who.owner, { dataset: 'attendance', from: '2026-02-01', to: '2026-01-01' }))).toBe(
			'invalid: The end date must be on or after the start date.'
		);
		expect((await csv('owner', 'attendance', { from: '2026-01-01', to: '2026-01-31' }))[0]).toContain('status');
		for (const dataset of ['assets', 'tickets', 'expenses'])
			expect((await csv('owner', dataset)).length).toBeGreaterThan(0);
		const events = await withTenant(sys(), (tx) =>
			tx
				.select({ table: auditLog.tableName, details: auditLog.newValues })
				.from(auditLog)
				.where(and(eq(auditLog.event, 'data.export'), eq(auditLog.actorUserId, who.owner.user.userId)))
		);
		expect(events.map((e) => e.table)).toEqual(expect.arrayContaining(['employees', 'salaries', 'attendance']));
		expect(events.filter((e) => e.table === 'attendance').map((e) => e.details)).toEqual([
			{ from: '2026-01-01', to: '2026-01-31' }
		]);
	});
});
