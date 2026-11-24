import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import {
	attendanceDays,
	departments,
	employees,
	leaveRequestDays,
	leaveRequests,
	leaveTypes,
	memberships,
	payrollRuns,
	payslips,
	reportShares,
	rolePermissions,
	roles
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type Access, type requireMember } from '../../src/lib/server/rbac/access';
import { reportCsv, reportPdf } from '../../src/lib/server/reports/files';
import { reportCtx, reportsFor, runReport } from '../../src/lib/server/reports/index';
import { headcountReport } from '../../src/lib/server/reports/people';
import {
	applySpec,
	openShare,
	shareList,
	shareRecipients,
	shareReport,
	type ShareInput
} from '../../src/lib/server/reports/shares';
import { getObject } from '../../src/lib/server/storage';
import type { Report } from '../../src/lib/server/reports/types';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const dept: Record<string, string> = {};
const who: Record<string, Access> = {};
const mem: Record<string, Member> = {};
const emails: Record<string, string> = {};
type Member = ReturnType<typeof requireMember>;
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
	const u = await createUser(`${key}-${crypto.randomUUID().slice(0, 8)}@test.local`);
	emails[key] = u.email;
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	who[key] = await loadAccess(tenant.id, { id, status: 'active', employeeId });
	mem[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: 'Acme Ltd' },
		access: who[key]
	} as unknown as Member;
}

const run = (key: string, id: string, raw: Record<string, string>) =>
	withTestNow('2026-11-24T06:00:00Z', () =>
		withTenant(reportCtx(mem[key], id), (tx) => runReport(tx, who[key], id, raw))
	);
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
	await member('boss', ['hr_admin'], null);
	await withTenant(sys(), async (tx) => {
		const [r] = await tx
			.insert(roles)
			.values({ tenantId: tenant.id, key: 'dept_reports', name: 'Department reports' })
			.returning({ id: roles.id });
		await tx
			.insert(rolePermissions)
			.values({ tenantId: tenant.id, roleId: r.id, permission: 'report.headcount', scope: 'department' });
	});
	await member('dh', ['dept_reports'], ids.ed);
	await member('gone', ['hr_admin'], null);
	await withTenant(sys(), (tx) =>
		tx.update(memberships).set({ status: 'disabled' }).where(eq(memberships.id, who.gone.membershipId))
	);
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
		expect(reportsFor(who.hr)).toEqual([
			{ id: 'headcount', title: 'Headcount and attrition' },
			{ id: 'attendance', title: 'Attendance' },
			{ id: 'leave', title: 'Leave taken' }
		]);
	});

	it('exports the same projection as CSV and PDF', async () => {
		const r = await run('hr', 'headcount', { ...october, department: dept.Engineering });
		const lines = reportCsv(r)
			.replace(/^\uFEFF/, '')
			.split('\r\n');
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

describe('sharing reports', () => {
	const at = <T>(iso: string, fn: () => Promise<T>) => withTestNow(iso, fn);
	const now = '2026-11-24T06:00:00Z';
	const full = () => run('hr', 'headcount', october);
	const spec = (f: Partial<Parameters<typeof applySpec>[1]> = {}) => ({
		sections: ['departments', 'leavers'],
		columns: ['departments:department', 'departments:end', 'leavers:name', 'leavers:lastDay'],
		employees: [],
		...f
	});
	const share = (key: string, f: Partial<ShareInput> = {}) =>
		at(now, () =>
			shareReport(mem[key], 'headcount', { filters: october, ...spec(), recipients: [who.boss.membershipId], ...f })
		);
	const outcome = (p: Promise<unknown>) =>
		p.then(
			() => 'ok',
			(e: { code?: string; message: string; issues?: { message: string }[] }) =>
				e.issues ? `invalid: ${e.issues[0].message}` : `${e.code}: ${e.message}`
		);

	it('keeps only the chosen sections, columns and employees', async () => {
		const r = applySpec(await full(), spec({ employees: [ids.fa] }));
		expect(r.sections.map((s) => [s.key, s.columns.map((c) => c.key)])).toEqual([
			['departments', ['department', 'end']],
			['leavers', ['name', 'lastDay']]
		]);
		expect(r.sections[0].rows.at(-1)!.cells).toEqual({ department: 'All departments', end: 4 });
		expect(r.sections[1].rows).toEqual([{ employeeId: ids.fa, cells: { name: 'Fa', lastDay: '2026-10-31' } }]);
		expect(applySpec(await full(), spec()).sections[1].rows.map((x) => x.cells.name)).toEqual(['Cy', 'Fa']);
		const bad = async (f: Partial<Parameters<typeof applySpec>[1]>) =>
			outcome(full().then((x) => applySpec(x, spec(f))));
		expect(await bad({ sections: ['salaries'] })).toBe('invalid: Choose sections from the list.');
		expect(await bad({ columns: ['departments:salary'] })).toBe('invalid: Choose columns from the list.');
		expect(await bad({ columns: ['departments:end'] })).toBe('invalid: Choose at least one column in Leavers.');
		expect(await bad({ employees: [ids.di] })).toBe('invalid: Choose employees from the list.');
	});

	it('offers only people who already see at least what the sharer sees', async () => {
		const names = async (key: string) =>
			(await withTenant(sys(), (tx) => shareRecipients(tx, who[key], headcountReport))).map(
				(r) => r.name.split('-')[0]
			);
		expect(await names('hr')).toEqual(['boss']);
		expect(await names('lead')).toEqual(['boss', 'dh', 'hr']);
		expect(await names('dh')).toEqual(['boss', 'hr']);
	});

	it('shares a snapshot, emails it with attachments and lets recipients open it', async () => {
		expect(await outcome(share('hr', { sections: [] }))).toBe('invalid: Choose at least one section to share.');
		expect(await outcome(share('hr', { recipients: [] }))).toBe('invalid: Choose at least one person to share with.');
		expect(await outcome(share('hr', { recipients: [who.lead.membershipId] }))).toBe(
			'invalid: Choose recipients from the list.'
		);
		expect(await outcome(share('emp'))).toBe('not_found: That report does not exist.');
		const { id, mails } = await share('hr', { recipients: [who.boss.membershipId, who.boss.membershipId] });
		const [row] = await withTenant(sys(), (tx) => tx.select().from(reportShares).where(eq(reportShares.id, id)));
		expect([row.recipientMembershipIds, row.expiresOn, row.period, row.spec.filters]).toEqual([
			[who.boss.membershipId],
			'2026-12-24',
			'2026-10-01 to 2026-10-31',
			{ ...october, department: '' }
		]);
		expect(mails.map((m) => [m.to, m.subject, m.attachments!.map((a) => a.filename)])).toEqual([
			[
				emails.boss,
				`${emails.hr} shared Headcount and attrition (2026-10-01 to 2026-10-31)`,
				['headcount-2026-10-01-2026-10-31.csv', 'headcount-2026-10-01-2026-10-31.pdf']
			]
		]);
		expect(new TextDecoder().decode(await getObject(mails[0].attachments![0].key))).toContain(
			'Department,After 2026-10-31'
		);

		const opened = await at(now, () => openShare(mem.boss, id));
		expect(opened.report).toEqual(applySpec(await full(), spec()));
		expect((await at(now, () => openShare(mem.hr, id))).share.expiresOn).toBe('2026-12-24');
		expect(await outcome(at(now, () => openShare(mem.lead, id)))).toBe(
			'not_found: That shared report does not exist or has expired.'
		);
		expect(await outcome(at('2026-12-24T06:00:00Z', () => openShare(mem.boss, id)))).toBe('ok');
		expect(await outcome(at('2026-12-25T06:00:00Z', () => openShare(mem.boss, id)))).toContain('not_found');
		expect(await outcome(at(now, () => openShare(mem.boss, 'nope')))).toContain('not_found');
		const audits = await withTenant(sys(), (tx) =>
			tx.execute<{ n: number }>(
				sql`select count(*)::int as n from audit_log where row_id = ${id} and event = 'report_share.open'`
			)
		);
		expect(audits[0].n).toBe(3);

		const list = (key: string) => at(now, () => withTenant(sys(), (tx) => shareList(tx, who[key])));
		expect((await list('boss')).map((s) => [s.id, s.mine, s.sharer])).toEqual([[id, false, emails.hr]]);
		expect((await list('hr')).map((s) => [s.id, s.mine])).toEqual([[id, true]]);
		expect(await list('lead')).toEqual([]);
		expect(await at('2026-12-25T06:00:00Z', () => withTenant(sys(), (tx) => shareList(tx, who.boss)))).toEqual([]);
		const revoked = { ...who.boss, grants: {} };
		expect(await at(now, () => withTenant(sys(), (tx) => shareList(tx, revoked)))).toEqual([]);
		expect(await outcome(at(now, () => openShare({ ...mem.boss, access: revoked }, id)))).toContain('not_found');
	});
});

async function grant(
	roleKey: string,
	permission: 'report.attendance' | 'report.leave' | 'report.payroll',
	scope: string
) {
	await withTenant(sys(), async (tx) => {
		const [r] = await tx.select().from(roles).where(eq(roles.key, roleKey));
		await tx.insert(rolePermissions).values({ tenantId: tenant.id, roleId: r.id, permission, scope });
	});
	for (const key of Object.keys(who).filter((k) => who[k].roleKeys.includes(roleKey))) {
		who[key] = await loadAccess(tenant.id, {
			id: who[key].membershipId,
			status: 'active',
			employeeId: who[key].employeeId
		});
		mem[key] = { ...mem[key], access: who[key] } as Member;
	}
}

describe('attendance and leave reports', () => {
	beforeAll(async () => {
		const day = (employeeId: string, date: string, status: string, workedMinutes = 0, lateMinutes = 0) => ({
			tenantId: tenant.id,
			employeeId,
			date,
			status,
			workedMinutes,
			lateMinutes
		});
		await withTenant(sys(), async (tx) => {
			await tx
				.insert(attendanceDays)
				.values([
					day(ids.ana, '2026-09-30', 'present', 480),
					day(ids.ana, '2026-10-01', 'present', 480),
					day(ids.ana, '2026-10-02', 'late', 465, 15),
					day(ids.ana, '2026-10-03', 'weekend'),
					day(ids.ana, '2026-10-04', 'absent'),
					day(ids.ana, '2026-11-01', 'absent'),
					day(ids.bo, '2026-10-10', 'wfh', 504),
					day(ids.bo, '2026-10-11', 'half_day', 240),
					day(ids.bo, '2026-10-12', 'on_leave'),
					day(ids.ab, '2026-10-15', 'late', 450, 10),
					day(ids.ab, '2026-10-16', 'late', 420, 30),
					day(ids.gi, '2026-10-02', 'holiday')
				]);
			const type = Object.fromEntries((await tx.select().from(leaveTypes)).map((t) => [t.code, t.id]));
			const leave = async (employeeId: string, code: string, status: string, days: [string, string][]) => {
				const [r] = await tx
					.insert(leaveRequests)
					.values({
						tenantId: tenant.id,
						employeeId,
						leaveTypeId: type[code],
						startDate: days[0][0],
						endDate: days.at(-1)![0],
						session: days.length === 1 ? days[0][1] : 'full',
						days: days.length,
						status,
						requestedByUserId: mem.hr.user.userId
					})
					.returning({ id: leaveRequests.id });
				await tx.insert(leaveRequestDays).values(
					days.map(([date, session]) => ({
						tenantId: tenant.id,
						requestId: r.id,
						employeeId,
						date,
						session,
						fiscalYear: 2026,
						status
					}))
				);
			};
			await leave(ids.ana, 'casual', 'approved', [
				['2026-10-05', 'full'],
				['2026-10-06', 'full']
			]);
			await leave(ids.ana, 'sick', 'approved', [['2026-10-07', 'am']]);
			await leave(ids.ana, 'casual', 'approved', [
				['2026-10-30', 'full'],
				['2026-10-31', 'full'],
				['2026-11-01', 'full']
			]);
			await leave(ids.ana, 'casual', 'approved', [['2026-09-29', 'full']]);
			await leave(ids.bo, 'casual', 'pending', [['2026-10-20', 'full']]);
			await leave(ids.bo, 'unpaid', 'rejected', [['2026-10-21', 'full']]);
			await leave(ids.bo, 'unpaid', 'cancelled', [['2026-10-22', 'full']]);
			await leave(ids.ab, 'sick', 'approved', [['2026-10-16', 'full']]);
		});
		await grant('team_reports', 'report.attendance', 'team');
		await grant('dept_reports', 'report.leave', 'department');
	});

	it('counts attendance days by status, late minutes and worked hours', async () => {
		const r = await run('hr', 'attendance', october);
		const zero = { present: 0, late: 0, half_day: 0, absent: 0, on_leave: 0, wfh: 0, lateMinutes: 0, workedHours: 0 };
		expect(table(r, 'employees')).toEqual([
			{
				name: 'Ab',
				code: expect.any(String),
				department: 'Operations',
				...zero,
				late: 2,
				lateMinutes: 40,
				workedHours: 14.5
			},
			{
				name: 'Ana',
				code: expect.any(String),
				department: 'Engineering',
				...zero,
				present: 1,
				late: 1,
				absent: 1,
				lateMinutes: 15,
				workedHours: 15.8
			},
			{
				name: 'Bo',
				code: expect.any(String),
				department: 'Engineering',
				...zero,
				half_day: 1,
				on_leave: 1,
				wfh: 1,
				workedHours: 12.4
			},
			{ name: 'Gi', code: expect.any(String), department: null, ...zero }
		]);
		expect(r.sections.find((s) => s.key === 'employees')!.rows.map((row) => row.employeeId)).toEqual([
			ids.ab,
			ids.ana,
			ids.bo,
			ids.gi
		]);
		expect(table(r, 'departments')).toEqual([
			{
				department: 'Engineering',
				...zero,
				present: 1,
				late: 1,
				half_day: 1,
				absent: 1,
				on_leave: 1,
				wfh: 1,
				lateMinutes: 15,
				workedHours: 28.2
			},
			{ department: 'No department', ...zero },
			{ department: 'Operations', ...zero, late: 2, lateMinutes: 40, workedHours: 14.5 },
			{
				department: 'All departments',
				...zero,
				present: 1,
				late: 3,
				half_day: 1,
				absent: 1,
				on_leave: 1,
				wfh: 1,
				lateMinutes: 55,
				workedHours: 42.7
			}
		]);
		expect(names(await run('hr', 'attendance', { ...october, department: dept.Operations }), 'employees')).toEqual([
			'Ab'
		]);
		expect(names(await run('lead', 'attendance', october), 'employees')).toEqual(['Ana', 'Bo']);
		expect(await fails('dh', 'attendance', october)).toBe('not_found');
	});

	it('sums approved leave days per type inside the period', async () => {
		const r = await run('hr', 'leave', october);
		const cols = r.sections.find((s) => s.key === 'employees')!.columns.map((c) => c.label);
		expect(cols).toEqual(['Name', 'Code', 'Department', 'Casual leave', 'Sick leave', 'Total days']);
		const [casual, sick] = r.sections[1].columns.slice(3).map((c) => c.key);
		expect(table(r, 'employees')).toEqual([
			{ name: 'Ab', code: expect.any(String), department: 'Operations', [casual]: 0, [sick]: 1, total: 1 },
			{ name: 'Ana', code: expect.any(String), department: 'Engineering', [casual]: 4, [sick]: 0.5, total: 4.5 }
		]);
		expect(table(r, 'departments')).toEqual([
			{ department: 'Engineering', [casual]: 4, [sick]: 0.5, total: 4.5 },
			{ department: 'Operations', [casual]: 0, [sick]: 1, total: 1 },
			{ department: 'All departments', [casual]: 4, [sick]: 1.5, total: 5.5 }
		]);
		expect(names(await run('dh', 'leave', october), 'employees')).toEqual(['Ana']);
		expect(names(await run('hr', 'leave', { ...october, department: dept.Operations }), 'employees')).toEqual(['Ab']);
		expect(table(await run('hr', 'leave', { from: '2026-11-01', to: '2026-11-24' }), 'employees')).toEqual([
			{ name: 'Ana', code: expect.any(String), department: 'Engineering', [casual]: 1, total: 1 }
		]);
		expect(await fails('lead', 'leave', october)).toBe('not_found');
		expect(reportsFor(who.dh).map((r) => r.id)).toEqual(['headcount', 'leave']);
	});
});

describe('payroll cost report', () => {
	beforeAll(async () => {
		await member('pay', ['payroll_officer'], null);
		await withTenant({ ...sys(), payrollAll: true }, async (tx) => {
			const run = async (period: string, status: string, slips: [string, number, string?][], runType = 'regular') => {
				const [r] = await tx
					.insert(payrollRuns)
					.values({
						tenantId: tenant.id,
						period,
						status,
						runType,
						title: runType === 'bonus' ? 'Puja bonus' : null,
						inputsHash: 'x',
						outputHash: 'x',
						computedByUserId: mem.hr.user.userId,
						computedAt: new Date()
					})
					.returning({ id: payrollRuns.id });
				await tx.insert(payslips).values(
					slips.map(([employeeId, gross, error]) => ({
						tenantId: tenant.id,
						runId: r.id,
						employeeId,
						gross,
						deductions: gross / 10,
						tax: gross / 20,
						net: gross - gross / 10 - gross / 20,
						error
					}))
				);
			};
			await run('2026-10', 'approved', [
				[ids.ana, 6_000_000],
				[ids.bo, 5_000_000],
				[ids.cy, 4_000_000],
				[ids.di, 3_000_000],
				[ids.ed, 2_000_000],
				[ids.ab, 2_500_000],
				[ids.gi, 1_000_000]
			]);
			await run('2026-10', 'void', [[ids.ana, 7_777_700]]);
			await run(
				'2026-10',
				'approved',
				[
					[ids.ab, 1_000_000],
					[ids.gi, 999_900, 'No salary on record.']
				],
				'bonus'
			);
			await run('2026-09', 'paid', [[ids.ana, 6_000_000]]);
			await run('2026-10', 'computed', [[ids.ana, 6_000_000]], 'bonus');
		});
		await grant('dept_reports', 'report.payroll', 'department');
	});

	it('totals approved and paid runs by department, month and employee for a company-wide viewer', async () => {
		const r = await run('pay', 'payroll', october);
		const all = { employees: 7, gross: '245000.00', deductions: '24500.00', tax: '12250.00', net: '208250.00' };
		expect(table(r, 'departments')).toEqual([
			{
				department: 'Engineering',
				employees: 5,
				gross: '200000.00',
				deductions: '20000.00',
				tax: '10000.00',
				net: '170000.00'
			},
			{
				department: 'No department',
				employees: 1,
				gross: '10000.00',
				deductions: '1000.00',
				tax: '500.00',
				net: '8500.00'
			},
			{
				department: 'Operations',
				employees: 1,
				gross: '35000.00',
				deductions: '3500.00',
				tax: '1750.00',
				net: '29750.00'
			},
			{ department: 'All departments', ...all }
		]);
		expect(table(r, 'months')).toEqual([{ month: '2026-10', ...all }]);
		expect(names(r, 'employees')).toEqual(['Ab', 'Ana', 'Bo', 'Cy', 'Di', 'Ed', 'Gi']);
		expect(table(r, 'employees')[1]).toEqual({
			name: 'Ana',
			code: expect.any(String),
			department: 'Engineering',
			gross: '60000.00',
			deductions: '6000.00',
			tax: '3000.00',
			net: '51000.00'
		});
		const two = await run('pay', 'payroll', { from: '2026-09-15', to: '2026-10-31', department: dept.Engineering });
		expect(table(two, 'months').map((c) => [c.month, c.employees, c.gross])).toEqual([
			['2026-09', 1, '60000.00'],
			['2026-10', 5, '200000.00']
		]);
		expect(table(two, 'employees')[0]).toMatchObject({ name: 'Ana', gross: '120000.00' });
		expect(reportsFor(who.pay).map((x) => x.id)).toEqual(['payroll']);
		expect(await fails('hr', 'payroll', october)).toBe('not_found');
	});

	it('hides groups under five people and the employee table from a limited viewer', async () => {
		const r = await run('dh', 'payroll', { from: '2026-09-01', to: '2026-10-31' });
		expect(r.sections.map((x) => x.key)).toEqual(['departments', 'months']);
		const hidden = { employees: '<5', gross: null, deductions: null, tax: null, net: null };
		expect(table(r, 'months')).toEqual([
			{ month: '2026-09', ...hidden },
			{ month: '2026-10', employees: 5, gross: '200000.00', deductions: '20000.00', tax: '10000.00', net: '170000.00' }
		]);
		expect(table(r, 'departments').map((c) => [c.department, c.employees, c.gross])).toEqual([
			['Engineering', 5, '260000.00'],
			['All departments', 5, '260000.00']
		]);
		const sep = await run('dh', 'payroll', { from: '2026-09-01', to: '2026-09-30' });
		expect(table(sep, 'departments')).toEqual([
			{ department: 'Engineering', ...hidden },
			{ department: 'All departments', ...hidden }
		]);
	});
});
