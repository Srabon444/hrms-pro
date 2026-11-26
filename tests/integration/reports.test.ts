import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import {
	attendanceDays,
	candidateStageHistory,
	candidates,
	departments,
	employees,
	expenseCategories,
	expenseClaims,
	expenseItems,
	interviews,
	jobOpenings,
	mealOrders,
	mealTypes,
	mealVendors,
	offers,
	pipelineStages,
	projects,
	shifts,
	ticketCategories,
	tickets,
	timesheetEntries,
	timesheets,
	workPlanItems,
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
import { REPORTS, reportCtx, reportsFor, runReport } from '../../src/lib/server/reports/index';
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
import { createTenant, createUser, TEST_LOCALE } from './helpers';
import type { Permission } from '../../src/lib/rbac/permissions';

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
		await seedTenant(tx, tenant.id, TEST_LOCALE);
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
			{ id: 'leave', title: 'Leave taken' },
			{ id: 'expense', title: 'Expenses' },
			{ id: 'recruitment', title: 'Recruitment funnel' },
			{ id: 'utilisation', title: 'Utilisation' },
			{ id: 'weekly', title: 'Weekly management report' }
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

	it('sends the weekly recruitment section only to people who may see recruitment', async () => {
		await withTenant(sys(), async (tx) => {
			const [r] = await tx
				.insert(roles)
				.values({ tenantId: tenant.id, key: 'weekly_only', name: 'Weekly only' })
				.returning({ id: roles.id });
			await tx
				.insert(rolePermissions)
				.values({ tenantId: tenant.id, roleId: r.id, permission: 'report.weekly', scope: 'all' });
		});
		await member('wk', ['weekly_only'], null);
		await member('hr2', ['hr_admin'], null);
		const full = await run('hr', 'weekly', {});
		const spec = (keep: (key: string) => boolean, recipient: string) => {
			const sections = full.sections.filter((s) => keep(s.key));
			return {
				filters: {},
				sections: sections.map((s) => s.key),
				columns: sections.flatMap((s) => s.columns.map((c) => `${s.key}:${c.key}`)),
				employees: [],
				recipients: [who[recipient].membershipId]
			};
		};
		const shareWeekly = (keep: (key: string) => boolean, recipient: string) =>
			at(now, () => shareReport(mem.hr, 'weekly', spec(keep, recipient)));
		expect(await outcome(shareWeekly(() => true, 'wk'))).toBe(
			'invalid: Someone you chose cannot see every section you picked. Leave those sections out.'
		);
		const { id } = await shareWeekly((k) => k !== 'recruitment', 'wk');
		expect((await at(now, () => openShare(mem.wk, id))).report.sections.map((s) => s.key)).toEqual([
			'attendance',
			'short_hours',
			'new_hires',
			'issues',
			'plan'
		]);
		const { id: whole } = await shareWeekly(() => true, 'hr2');
		expect((await at(now, () => openShare(mem.hr2, whole))).report.sections.map((s) => s.key)).toContain('recruitment');
		const weeklyOnly = { ...mem.hr2, access: { ...who.hr2, grants: { 'report.weekly': ['all'] } } } as Member;
		expect(await outcome(at(now, () => openShare(weeklyOnly, whole)))).toContain('not_found');
	});

	it('shares every report in full with someone who sees everything', async () => {
		await member('own1', ['owner'], null);
		await member('own2', ['owner'], null);
		for (const def of REPORTS) {
			const report = await run('own1', def.id, october);
			const spec = {
				sections: report.sections.map((s) => s.key),
				columns: report.sections.flatMap((s) => s.columns.map((c) => `${s.key}:${c.key}`)),
				employees: []
			};
			const { id } = await at(now, () =>
				shareReport(mem.own1, def.id, { filters: october, ...spec, recipients: [who.own2.membershipId] })
			);
			expect((await at(now, () => openShare(mem.own2, id))).report, def.id).toEqual(applySpec(report, spec));
		}
	});
});

async function grant(roleKey: string, permission: Permission, scope: string) {
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

describe('meal, expense, recruitment and utilisation reports', () => {
	beforeAll(async () => {
		await member('meal', ['meal_manager'], null);
		await member('fin', ['finance'], null);
		await member('rec', ['recruiter'], null);
		const by = mem.hr.user.userId;
		await withTenant(sys(), async (tx) => {
			const vendor = async (name: string, meal: string) => {
				const [v] = await tx
					.insert(mealVendors)
					.values({ tenantId: tenant.id, name })
					.returning({ id: mealVendors.id });
				const [t] = await tx
					.insert(mealTypes)
					.values({ tenantId: tenant.id, name: meal, vendorId: v.id })
					.returning({ id: mealTypes.id });
				return t.id;
			};
			const lunch = await vendor('Vendor A', 'Lunch');
			const dinner = await vendor('Vendor B', 'Dinner');
			const order = (
				employeeId: string,
				date: string,
				mealTypeId: string,
				status: string,
				guestQty: number,
				unitCost: number | null,
				subsidyPct: number | null
			) => ({
				tenantId: tenant.id,
				employeeId,
				date,
				mealTypeId,
				status,
				guestQty,
				unitCost,
				subsidyPct
			});
			await tx
				.insert(mealOrders)
				.values([
					order(ids.ana, '2026-09-30', lunch, 'ordered', 0, 10_000, 50),
					order(ids.ana, '2026-10-01', lunch, 'ordered', 0, 10_000, 50),
					order(ids.ana, '2026-10-02', lunch, 'ordered', 2, 10_000, 50),
					order(ids.ana, '2026-10-03', lunch, 'opted_out', 0, 10_000, 50),
					order(ids.ana, '2026-10-04', lunch, 'ordered', 0, null, null),
					order(ids.ana, '2026-11-01', lunch, 'ordered', 0, 10_000, 50),
					order(ids.bo, '2026-10-05', dinner, 'ordered', 0, 15_000, 0),
					order(ids.ab, '2026-10-06', lunch, 'ordered', 1, 10_000, 50)
				]);

			const category = async (name: string) =>
				(
					await tx
						.insert(expenseCategories)
						.values({ tenantId: tenant.id, name })
						.returning({ id: expenseCategories.id })
				)[0].id;
			const travel = await category('Travel');
			const food = await category('Food');
			const claim = async (employeeId: string, status: string, items: [string, string, number][]) => {
				const [c] = await tx
					.insert(expenseClaims)
					.values({
						tenantId: tenant.id,
						employeeId,
						title: 'Claim',
						status,
						total: items.reduce((n, i) => n + i[2], 0),
						submittedByUserId: by
					})
					.returning({ id: expenseClaims.id });
				await tx.insert(expenseItems).values(
					items.map(([categoryId, spentOn, amount]) => ({
						tenantId: tenant.id,
						claimId: c.id,
						categoryId,
						spentOn,
						description: 'Item',
						amount
					}))
				);
			};
			await claim(ids.ana, 'approved', [
				[travel, '2026-10-03', 50_000],
				[food, '2026-10-04', 20_000]
			]);
			await claim(ids.ana, 'paid', [[travel, '2026-09-30', 99_900]]);
			await claim(ids.ana, 'approved', [
				[food, '2026-10-31', 5_000],
				[food, '2026-11-01', 7_000]
			]);
			await claim(ids.bo, 'paid', [[travel, '2026-10-10', 30_000]]);
			await claim(ids.bo, 'submitted', [[food, '2026-10-11', 11_100]]);
			await claim(ids.bo, 'rejected', [[travel, '2026-10-11', 22_200]]);
			await claim(ids.ab, 'paid', [[food, '2026-10-12', 10_000]]);

			const opening = async (title: string, departmentId: string | null, status: string) => {
				const [o] = await tx
					.insert(jobOpenings)
					.values({ tenantId: tenant.id, title, departmentId, status })
					.returning({ id: jobOpenings.id });
				const stage: Record<string, string> = {};
				for (const [i, kind] of ['active', 'hired', 'rejected'].entries())
					stage[kind] = (
						await tx
							.insert(pipelineStages)
							.values({ tenantId: tenant.id, openingId: o.id, name: kind, sortOrder: i, kind })
							.returning({ id: pipelineStages.id })
					)[0].id;
				const candidate = async (fullName: string, createdAt: string) =>
					(
						await tx
							.insert(candidates)
							.values({
								tenantId: tenant.id,
								openingId: o.id,
								stageId: stage.active,
								fullName,
								createdAt: new Date(createdAt)
							})
							.returning({ id: candidates.id })
					)[0].id;
				const move = (candidateId: string, kind: string, at: string) =>
					tx.insert(candidateStageHistory).values({
						tenantId: tenant.id,
						candidateId,
						fromStageId: stage.active,
						toStageId: stage[kind],
						createdAt: new Date(at)
					});
				const interview = (candidateId: string, at: string, status: string) =>
					tx.insert(interviews).values({
						tenantId: tenant.id,
						candidateId,
						title: 'Interview',
						scheduledAt: new Date(at),
						durationMinutes: 60,
						status
					});
				return { candidate, move, interview };
			};
			const backend = await opening('Backend engineer', dept.Engineering, 'open');
			const c1 = await backend.candidate('C1', '2026-10-05T04:00:00Z');
			await backend.interview(c1, '2026-10-10T04:00:00Z', 'scheduled');
			await backend.interview(c1, '2026-10-11T04:00:00Z', 'scheduled');
			await tx.insert(offers).values({
				tenantId: tenant.id,
				candidateId: c1,
				monthlyGross: 10_000_000,
				joinDate: '2026-11-15',
				status: 'accepted',
				decidedAt: new Date('2026-10-14T04:00:00Z'),
				createdAt: new Date('2026-10-12T04:00:00Z')
			});
			await backend.move(c1, 'hired', '2026-10-20T04:00:00Z');
			const c2 = await backend.candidate('C2', '2026-10-06T04:00:00Z');
			await backend.interview(c2, '2026-10-11T04:00:00Z', 'cancelled');
			await backend.move(c2, 'rejected', '2026-10-15T04:00:00Z');
			await tx.insert(offers).values({
				tenantId: tenant.id,
				candidateId: c2,
				monthlyGross: 9_000_000,
				joinDate: '2026-11-15',
				status: 'declined',
				decidedAt: new Date('2026-10-14T04:00:00Z'),
				createdAt: new Date('2026-10-13T04:00:00Z')
			});
			const c3 = await backend.candidate('C3', '2026-09-20T04:00:00Z');
			await backend.interview(c3, '2026-10-02T04:00:00Z', 'scheduled');
			await backend.move(c3, 'rejected', '2026-11-02T04:00:00Z');
			await tx.insert(offers).values({
				tenantId: tenant.id,
				candidateId: c3,
				monthlyGross: 9_000_000,
				joinDate: '2026-12-15',
				status: 'accepted',
				decidedAt: new Date('2026-11-03T04:00:00Z'),
				createdAt: new Date('2026-10-30T04:00:00Z')
			});
			await backend.candidate('C4', '2026-10-31T20:00:00Z');
			const ops = await opening('Ops lead', dept.Operations, 'closed');
			await ops.candidate('C7', '2026-08-01T04:00:00Z');
			const designer = await opening('Designer', null, 'on_hold');
			await designer.candidate('C5', '2026-10-01T04:00:00Z');
			await designer.candidate('C6', '2026-09-30T19:00:00Z');

			const [general] = await tx.select().from(shifts).where(eq(shifts.isDefault, true));
			await tx.update(attendanceDays).set({ shiftId: general.id });
			const project = async (code: string, billable: boolean) =>
				(
					await tx
						.insert(projects)
						.values({
							tenantId: tenant.id,
							code,
							name: `${code} project`,
							client: billable ? 'Client Co' : '',
							billable
						})
						.returning({ id: projects.id })
				)[0].id;
			const app = await project('APP', true);
			const internal = await project('INT', false);
			const sheet = async (
				employeeId: string,
				weekStart: string,
				status: string,
				entries: [string, string, number][]
			) => {
				const [t] = await tx
					.insert(timesheets)
					.values({
						tenantId: tenant.id,
						employeeId,
						weekStart,
						status,
						submittedAt: new Date(),
						decidedAt: status === 'approved' ? new Date() : null
					})
					.returning({ id: timesheets.id });
				await tx.insert(timesheetEntries).values(
					entries.map(([projectId, workDate, minutes]) => ({
						tenantId: tenant.id,
						timesheetId: t.id,
						projectId,
						workDate,
						minutes
					}))
				);
			};
			await sheet(ids.ana, '2026-09-28', 'approved', [
				[app, '2026-09-30', 480],
				[app, '2026-10-01', 360],
				[app, '2026-10-02', 240],
				[internal, '2026-10-02', 120]
			]);
			await sheet(ids.bo, '2026-10-05', 'submitted', [[app, '2026-10-10', 480]]);
			await sheet(ids.ab, '2026-10-12', 'approved', [[internal, '2026-10-15', 480]]);
			await sheet(ids.ab, '2026-10-26', 'approved', [[internal, '2026-11-01', 480]]);
		});
		for (const p of ['report.meal', 'report.expense', 'report.recruitment', 'report.utilisation'] as const)
			await grant('dept_reports', p, 'department');
	});

	it('splits priced meals into cost, staff share and company share', async () => {
		const r = await run('meal', 'meal', october);
		expect(table(r, 'meals')).toEqual([
			{ meal: 'Vendor A · Lunch', plates: 3, guests: 3, cost: '600.00', staff: '450.00', company: '150.00' },
			{ meal: 'Vendor B · Dinner', plates: 1, guests: 0, cost: '150.00', staff: '150.00', company: '0.00' },
			{ meal: 'All meals', plates: 4, guests: 3, cost: '750.00', staff: '600.00', company: '150.00' }
		]);
		expect(table(r, 'employees').map((c) => [c.name, c.plates, c.guests, c.cost, c.staff, c.company])).toEqual([
			['Ab', 1, 1, '200.00', '150.00', '50.00'],
			['Ana', 2, 2, '400.00', '300.00', '100.00'],
			['Bo', 1, 0, '150.00', '150.00', '0.00']
		]);
		expect(table(r, 'departments').map((c) => [c.department, c.plates, c.cost])).toEqual([
			['Engineering', 3, '550.00'],
			['Operations', 1, '200.00'],
			['All departments', 4, '750.00']
		]);
		expect(names(await run('dh', 'meal', october), 'employees')).toEqual(['Ana', 'Bo']);
		expect(names(await run('fin', 'meal', { ...october, department: dept.Operations }), 'employees')).toEqual(['Ab']);
		expect(await fails('emp', 'meal', october)).toBe('not_found');
	});

	it('totals approved and paid expense items by the day they were spent', async () => {
		const r = await run('fin', 'expense', october);
		expect(table(r, 'categories')).toEqual([
			{ category: 'Food', items: 3, approved: '250.00', paid: '100.00', total: '350.00' },
			{ category: 'Travel', items: 2, approved: '500.00', paid: '300.00', total: '800.00' },
			{ category: 'All categories', items: 5, approved: '750.00', paid: '400.00', total: '1150.00' }
		]);
		expect(table(r, 'employees').map((c) => [c.name, c.items, c.approved, c.paid, c.total])).toEqual([
			['Ab', 1, '0.00', '100.00', '100.00'],
			['Ana', 3, '750.00', '0.00', '750.00'],
			['Bo', 1, '0.00', '300.00', '300.00']
		]);
		expect(table(r, 'departments').at(-1)).toEqual({
			department: 'All departments',
			items: 5,
			approved: '750.00',
			paid: '400.00',
			total: '1150.00'
		});
		expect(names(await run('dh', 'expense', october), 'employees')).toEqual(['Ana', 'Bo']);
		expect(await fails('meal', 'expense', october)).toBe('not_found');
	});

	it('counts funnel steps that happened in the period, in the company time zone', async () => {
		const r = await run('rec', 'recruitment', october);
		const step = (
			applied: number,
			interviewed: number,
			offered: number,
			accepted: number,
			hired: number,
			rejected: number
		) => ({
			applied,
			interviewed,
			offered,
			accepted,
			hired,
			rejected
		});
		expect(table(r, 'openings')).toEqual([
			{ opening: 'Backend engineer', department: 'Engineering', status: 'open', ...step(2, 2, 3, 1, 1, 1) },
			{ opening: 'Designer', department: null, status: 'on_hold', ...step(2, 0, 0, 0, 0, 0) },
			{ opening: 'All openings', department: null, status: null, ...step(4, 2, 3, 1, 1, 1) }
		]);
		const eng = await run('rec', 'recruitment', { ...october, department: dept.Engineering });
		expect(table(eng, 'openings').map((c) => c.opening)).toEqual(['Backend engineer', 'All openings']);
		const dh = await run('dh', 'recruitment', october);
		expect(table(dh, 'openings').map((c) => c.opening)).toEqual(['Backend engineer', 'All openings']);
		const august = await run('rec', 'recruitment', { from: '2026-08-01', to: '2026-08-31' });
		expect(table(august, 'openings').map((c) => [c.opening, c.applied])).toEqual([
			['Backend engineer', 0],
			['Designer', 0],
			['Ops lead', 1],
			['All openings', 1]
		]);
	});

	it('compares billable approved hours with scheduled capacity', async () => {
		const r = await run('hr', 'utilisation', october);
		expect(table(r, 'employees').map((c) => [c.name, c.capacity, c.logged, c.billable, c.utilisation])).toEqual([
			['Ab', 16, 8, 0, 0],
			['Ana', 24, 12, 10, 41.7],
			['Bo', 16, 0, 0, 0]
		]);
		expect(table(r, 'departments').map((c) => [c.department, c.capacity, c.logged, c.billable, c.utilisation])).toEqual(
			[
				['Engineering', 40, 12, 10, 25],
				['Operations', 16, 8, 0, 0],
				['All departments', 56, 20, 10, 17.9]
			]
		);
		expect(table(r, 'projects')).toEqual([
			{ code: 'APP', project: 'APP project', client: 'Client Co', billable: 'Yes', people: 1, hours: 10 },
			{ code: 'INT', project: 'INT project', client: '', billable: 'No', people: 2, hours: 10 }
		]);
		expect(names(await run('hr', 'utilisation', { ...october, department: dept.Operations }), 'employees')).toEqual([
			'Ab'
		]);
		const dh = await run('dh', 'utilisation', october);
		expect(names(dh, 'employees')).toEqual(['Ana', 'Bo']);
		expect(table(dh, 'projects').map((c) => [c.code, c.people, c.hours])).toEqual([
			['APP', 1, 10],
			['INT', 1, 2]
		]);
		const empty = await run('hr', 'utilisation', { from: '2026-12-01', to: '2026-12-31' });
		expect(table(empty, 'departments')).toEqual([
			{ department: 'All departments', capacity: 0, logged: 0, billable: 0, utilisation: null }
		]);
	});
});

describe('weekly management report', () => {
	beforeAll(async () => {
		await withTenant(sys(), async (tx) => {
			const [general] = await tx.select().from(shifts).where(eq(shifts.isDefault, true));
			const day = { tenantId: tenant.id, employeeId: ids.ana, status: 'present', shiftId: general.id };
			await tx.insert(attendanceDays).values([
				{ ...day, date: '2026-11-24', workedMinutes: 100 },
				{ ...day, date: '2026-11-03', workedMinutes: 300 }
			]);
			const category = async (name: string, confidential: boolean) =>
				(
					await tx
						.insert(ticketCategories)
						.values({ tenantId: tenant.id, name, confidential, slaHours: 24 })
						.returning({ id: ticketCategories.id })
				)[0].id;
			const open = await category('Report facilities', false);
			const secret = await category('Report grievance', true);
			const ticket = (
				number: number,
				requesterEmployeeId: string,
				categoryId: string,
				status: string,
				createdAt: string,
				assigneeMembershipId: string | null = null
			) => ({
				tenantId: tenant.id,
				number,
				categoryId,
				requesterEmployeeId,
				subject: `Issue ${number}`,
				description: 'Details',
				status,
				resolvedAt: ['resolved', 'closed'].includes(status) ? new Date(createdAt) : null,
				assigneeMembershipId,
				slaDueAt: new Date(createdAt),
				createdAt: new Date(createdAt)
			});
			await tx
				.insert(tickets)
				.values([
					ticket(1, ids.ana, open, 'open', '2026-09-20T04:00:00Z'),
					ticket(2, ids.bo, open, 'resolved', '2026-10-05T04:00:00Z', who.hr.membershipId),
					ticket(3, ids.ab, open, 'closed', '2026-09-10T04:00:00Z'),
					ticket(4, ids.ana, open, 'open', '2026-11-02T04:00:00Z'),
					ticket(5, ids.gi, secret, 'open', '2026-10-03T04:00:00Z'),
					ticket(6, ids.ab, open, 'open', '2026-10-31T19:00:00Z'),
					ticket(7, ids.ana, open, 'open', '2026-10-31T10:00:00Z'),
					ticket(8, ids.bo, open, 'closed', '2026-09-30T20:00:00Z')
				]);
			const item = (employeeId: string, weekStart: string, description: string, status: string) => ({
				tenantId: tenant.id,
				employeeId,
				weekStart,
				description,
				target: '1',
				status
			});
			await tx
				.insert(workPlanItems)
				.values([
					item(ids.ana, '2026-09-20', 'Old item', 'done'),
					item(ids.ana, '2026-09-27', 'Ship login', 'done'),
					item(ids.bo, '2026-11-01', 'Plan sprint', 'pending'),
					item(ids.ab, '2026-11-08', 'Later item', 'pending')
				]);
		});
	});

	it('brings attendance, short days, recruitment, hires, issues and the work plan into one report', async () => {
		const r = await run('hr', 'weekly', october);
		expect(r.sections.map((s) => s.key)).toEqual([
			'attendance',
			'short_hours',
			'recruitment',
			'new_hires',
			'issues',
			'plan'
		]);
		expect(table(r, 'attendance').at(-1)).toMatchObject({ department: 'All departments', present: 1, late: 3 });
		expect(table(r, 'short_hours').map((c) => [c.name, c.date, c.worked, c.required])).toEqual([
			['Ana', '2026-10-02', 7.8, 8],
			['Ab', '2026-10-15', 7.5, 8],
			['Ab', '2026-10-16', 7, 8]
		]);
		expect(table(r, 'recruitment').at(-1)).toMatchObject({ opening: 'All openings', applied: 4, hired: 1 });
		expect(table(r, 'new_hires').map((c) => [c.name, c.joins])).toEqual([
			['Gi', '2026-10-01'],
			['Bo', '2026-10-10'],
			['Ab', '2026-10-15'],
			['Ed', '2026-11-05']
		]);
		expect(table(r, 'issues')).toEqual([
			{
				number: '#1',
				subject: 'Issue 1',
				category: 'Report facilities',
				requester: 'Ana',
				priority: 'normal',
				status: 'open',
				assignee: null
			},
			{
				number: '#2',
				subject: 'Issue 2',
				category: 'Report facilities',
				requester: 'Bo',
				priority: 'normal',
				status: 'resolved',
				assignee: emails.hr
			},
			{
				number: '#7',
				subject: 'Issue 7',
				category: 'Report facilities',
				requester: 'Ana',
				priority: 'normal',
				status: 'open',
				assignee: null
			},
			{
				number: '#8',
				subject: 'Issue 8',
				category: 'Report facilities',
				requester: 'Bo',
				priority: 'normal',
				status: 'closed',
				assignee: null
			}
		]);
		expect(table(r, 'plan').map((c) => [c.week, c.name, c.item, c.status])).toEqual([
			['2026-09-27', 'Ana', 'Ship login', 'done'],
			['2026-11-01', 'Bo', 'Plan sprint', 'pending']
		]);
		expect(await fails('lead', 'weekly', october)).toBe('not_found');
		await grant('team_reports', 'report.weekly', 'team');
		const team = await run('lead', 'weekly', october);
		expect(table(team, 'issues').map((c) => c.number)).toEqual(['#1', '#2', '#7', '#8']);
		expect(table(team, 'new_hires').map((c) => c.name)).toEqual(['Bo']);
		expect(team.sections.map((s) => s.key)).not.toContain('recruitment');
		expect(await fails('emp', 'weekly', october)).toBe('not_found');
		await grant('team_reports', 'report.recruitment', 'all');
		expect(table(await run('lead', 'weekly', october), 'recruitment')).toEqual(table(r, 'recruitment'));
		const ops = await run('hr', 'weekly', { ...october, department: dept.Operations });
		expect(table(ops, 'short_hours').map((c) => c.name)).toEqual(['Ab', 'Ab']);
		expect(table(ops, 'new_hires').map((c) => c.name)).toEqual(['Ab']);
		expect(table(await run('hr', 'weekly', { from: '2026-11-01', to: '2026-11-02' }), 'short_hours')).toEqual([]);
	});

	it('defaults to the current week and leaves today out of short days', async () => {
		const r = await run('hr', 'weekly', {});
		expect([r.params.from, r.params.to]).toEqual(['2026-11-22', '2026-11-24']);
		expect(table(r, 'short_hours')).toEqual([]);
		expect(table(r, 'attendance').at(-1)).toMatchObject({ present: 1 });
		const month = await run('hr', 'attendance', {});
		expect(month.params.from).toBe('2026-11-01');
	});
});
