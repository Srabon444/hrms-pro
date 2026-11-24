import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import { departments, employees, memberships, rolePermissions, roles } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type Access } from '../../src/lib/server/rbac/access';
import { reportCsv, reportPdf } from '../../src/lib/server/reports/files';
import { reportsFor, runReport } from '../../src/lib/server/reports/index';
import type { Report } from '../../src/lib/server/reports/types';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const dept: Record<string, string> = {};
const who: Record<string, Access> = {};
const sys = () => systemCtx(tenant.id);
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};

async function hire(fullName: string, joinDate: string, departmentId = '', managerId = '', exitDate?: string) {
	const id = await createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		managerId,
		departmentId,
		employmentType: 'full_time',
		status: 'active',
		joinDate
	});
	if (exitDate)
		await withTenant(sys(), (tx) =>
			tx.update(employees).set({ exitDate, status: 'exited' }).where(eq(employees.id, id))
		);
	return id;
}

async function member(key: string, roleKeys: string[], employeeId: string | null) {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	who[key] = await loadAccess(tenant.id, { id, status: 'active', employeeId });
}

const run = (key: string, id: string, raw: Record<string, string>) =>
	withTestNow('2026-11-24T06:00:00Z', () => withTenant(sys(), (tx) => runReport(tx, who[key], id, raw)));
const fails = (key: string, id: string, raw: Record<string, string>) =>
	run(key, id, raw).then(
		() => 'ok',
		(e: { code?: string; issues?: { message: string }[] }) => (e.issues ? `invalid: ${e.issues[0].message}` : e.code)
	);
const october = { from: '2026-10-01', to: '2026-10-31' };
const table = (r: Report, key: string) => r.sections.find((s) => s.key === key)!.rows.map((row) => row.cells);
const names = (r: Report, key: string) => table(r, key).map((c) => c.name);

beforeAll(async () => {
	tenant = await createTenant('reports');
	await withTenant(sys(), async (tx) => {
		await seedTenant(tx, tenant.id);
		for (const name of ['Engineering', 'Operations'])
			[{ id: dept[name] }] = await tx
				.insert(departments)
				.values({ tenantId: tenant.id, name })
				.returning({ id: departments.id });
	});
	ids.ana = await hire('Ana', '2025-01-01', dept.Engineering);
	ids.bo = await hire('Bo', '2026-10-10', dept.Engineering, ids.ana);
	ids.cy = await hire('Cy', '2025-05-01', dept.Engineering, ids.ana, '2026-10-20');
	ids.di = await hire('Di', '2025-01-01', dept.Engineering, '', '2026-09-30');
	ids.ed = await hire('Ed', '2026-11-05', dept.Engineering);
	ids.fa = await hire('Fa', '2024-01-01', dept.Operations, '', '2026-10-31');
	ids.gi = await hire('Gi', '2026-10-01');
	ids.ab = await hire('Ab', '2026-10-15', dept.Operations);
	await withTenant(sys(), async (tx) => {
		const [r] = await tx
			.insert(roles)
			.values({ tenantId: tenant.id, key: 'team_reports', name: 'Team reports' })
			.returning({ id: roles.id });
		await tx
			.insert(rolePermissions)
			.values({ tenantId: tenant.id, roleId: r.id, permission: 'report.headcount', scope: 'team' });
	});
	await member('hr', ['hr_admin'], null);
	await member('lead', ['team_reports'], ids.ana);
	await member('emp', ['employee'], ids.gi);
});

afterAll(closePools);

describe('headcount report', () => {
	it('counts the period by department with attrition', async () => {
		const r = await run('hr', 'headcount', october);
		expect(table(r, 'departments')).toEqual([
			{ department: 'Engineering', start: 2, joiners: 1, leavers: 1, end: 2, attrition: 50 },
			{ department: 'No department', start: 0, joiners: 1, leavers: 0, end: 1, attrition: 0 },
			{ department: 'Operations', start: 1, joiners: 1, leavers: 1, end: 1, attrition: 100 },
			{ department: 'All departments', start: 3, joiners: 3, leavers: 2, end: 4, attrition: 57.1 }
		]);
		expect(names(r, 'joiners')).toEqual(['Ab', 'Bo', 'Gi']);
		expect(table(r, 'joiners')[1]).toEqual({
			name: 'Bo',
			code: expect.any(String),
			department: 'Engineering',
			designation: null,
			joined: '2026-10-10'
		});
		expect(r.sections.find((s) => s.key === 'joiners')!.rows.map((x) => x.employeeId)).toEqual([
			ids.ab,
			ids.bo,
			ids.gi
		]);
		expect(r.sections.find((s) => s.key === 'leavers')!.rows.map((x) => x.employeeId)).toEqual([ids.cy, ids.fa]);
		expect(table(r, 'leavers').map((c) => `${c.name}:${c.lastDay}`)).toEqual(['Cy:2026-10-20', 'Fa:2026-10-31']);
	});

	it('filters by department and by the viewer scope', async () => {
		const eng = await run('hr', 'headcount', { ...october, department: dept.Engineering });
		expect(eng.params.departmentName).toBe('Engineering');
		expect(table(eng, 'departments').map((c) => c.department)).toEqual(['Engineering', 'All departments']);
		expect(names(eng, 'joiners')).toEqual(['Bo']);
		const team = await run('lead', 'headcount', october);
		expect(table(team, 'departments').at(-1)).toEqual({
			department: 'All departments',
			start: 2,
			joiners: 1,
			leavers: 1,
			end: 2,
			attrition: 50
		});
		const empty = await run('hr', 'headcount', { from: '2020-01-01', to: '2020-01-31' });
		expect(table(empty, 'departments')).toEqual([
			{ department: 'All departments', start: 0, joiners: 0, leavers: 0, end: 0, attrition: null }
		]);
	});

	it('checks the filters and who may run it', async () => {
		const mtd = await run('hr', 'headcount', {});
		expect([mtd.params.from, mtd.params.to]).toEqual(['2026-11-01', '2026-11-24']);
		expect(names(mtd, 'joiners')).toEqual(['Ed']);
		expect(await fails('hr', 'headcount', { from: '2026-10-02', to: '2026-10-01' })).toBe('bad_range');
		expect(await fails('hr', 'headcount', { from: '2025-01-01', to: '2026-01-02' })).toBe('bad_range');
		expect(await fails('hr', 'headcount', { from: '2025-01-01', to: '2026-01-01' })).toBe('ok');
		expect(await fails('hr', 'headcount', { department: crypto.randomUUID() })).toBe('not_found');
		expect(await fails('hr', 'headcount', { department: 'nope' })).toBe('invalid: Choose a department from the list.');
		expect(await fails('hr', 'headcount', { to: '31/10/2026' })).toBe('invalid: Enter the end as a date.');
		expect(await fails('emp', 'headcount', october)).toBe('not_found');
		expect(await fails('hr', 'nope', october)).toBe('not_found');
		expect(reportsFor(who.emp)).toEqual([]);
		expect(reportsFor(who.hr)).toEqual([{ id: 'headcount', title: 'Headcount and attrition' }]);
	});

	it('exports the same projection as CSV and PDF', async () => {
		const r = await run('hr', 'headcount', { ...october, department: dept.Engineering });
		const lines = reportCsv(r).replace(/^﻿/, '').split('\r\n');
		expect(lines.slice(0, 6)).toEqual([
			'Headcount and attrition',
			'2026-10-01 to 2026-10-31 · Engineering',
			'',
			'By department',
			'Department,On 2026-10-01,Joined,Left,After 2026-10-31,Attrition %',
			'Engineering,2,1,1,2,50'
		]);
		expect(lines).toContain('Leavers');
		const pdf = await reportPdf('Acme', r);
		expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-');
	});
});
