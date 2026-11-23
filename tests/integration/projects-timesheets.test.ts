import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import {
	employees,
	memberships,
	notifications,
	rolePermissions,
	roles,
	tenantSettings,
	timesheets
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import {
	projectList,
	projectView,
	removeProjectMember,
	saveProject,
	setProjectMember
} from '../../src/lib/server/projects';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import {
	decideTimesheet,
	logTime,
	myWeek,
	removeEntry,
	submitWeek,
	timesheetApprovals,
	timesheetView
} from '../../src/lib/server/timesheets';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const proj: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const at = <T>(fn: () => Promise<T>) => withTestNow('2026-11-24T06:00:00Z', fn);
const code = (p: () => Promise<unknown>) =>
	at(p)
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
const hire = (fullName: string, managerId = '') =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		managerId,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01'
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

const WEEK = '2026-11-22';
const save = (key: string, f: Record<string, string>) =>
	code(() => saveProject(who[key], { name: 'Project', ...f }).then((id) => (proj[f.code.toUpperCase()] ??= id)));
const staff = (key: string, p: string, e: string, allocation: string, role = 'member') =>
	code(() => setProjectMember(who[key], { projectId: proj[p], employeeId: ids[e], role, allocation }));
const log = (key: string, p: string, workDate: string, hours: string) =>
	code(() => logTime(who[key], { projectId: proj[p] ?? p, workDate, hours, note: '' }));
const read = <T>(key: string, fn: (tx: never, access: Member['access']) => Promise<T>) =>
	at(() => withTenant(userCtx(who[key]), (tx) => fn(tx as never, who[key].access)));
const week = (key: string, w: string | null = WEEK) => read(key, (tx, a) => myWeek(tx, a, w));
const sheetOf = async (key: string, w = WEEK) => (await week(key, w))!.sheet!;
const decide = (key: string, sheetId: string, decision: string, note = '') =>
	code(() => decideTimesheet(who[key], sheetId, { decision, note }));
const waiting = async (key: string) => (await read(key, timesheetApprovals)).map((r) => r.title);

beforeAll(async () => {
	tenant = await createTenant('timesheets');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.lea = await hire('Lea');
	ids.ana = await hire('Ana', ids.lea);
	ids.cal = await hire('Cal');
	ids.ben = await hire('Ben', ids.cal);
	ids.old = await hire('Old');
	await withTenant(sys(), (tx) => tx.update(employees).set({ status: 'exited' }).where(eq(employees.id, ids.old)));
	await withTenant(sys(), async (tx) => {
		const [r] = await tx.insert(roles).values({ tenantId: tenant.id, key: 'pm', name: 'PM' }).returning();
		await tx.insert(rolePermissions).values([
			{ tenantId: tenant.id, roleId: r.id, permission: 'project.manage', scope: 'all' },
			{ tenantId: tenant.id, roleId: r.id, permission: 'project.read', scope: 'all' }
		]);
	});
	await member('pm', ['pm'], null);
	await member('lea', ['line_manager'], ids.lea);
	await member('ana', [], ids.ana);
	await member('ben', [], ids.ben);
	await member('cal', [], ids.cal);
});

afterAll(closePools);

describe('projects', () => {
	it('lets only project managers create and edit projects with unique codes', async () => {
		expect(await save('pm', { code: 'alpha', name: 'Alpha', billable: 'on' })).toBe('ok');
		expect(await save('pm', { code: 'BETA' })).toBe('ok');
		expect(await save('pm', { code: 'GAMMA' })).toBe('ok');
		expect(await save('pm', { code: 'ALPHA' })).toBe('code_exists');
		expect(await save('pm', { code: 'A' })).toBe('invalid: Use 2 to 12 letters, digits or dashes for the code.');
		expect(await save('ana', { code: 'ANA' })).toBe('forbidden');
		expect(
			await code(() => saveProject(who.pm, { projectId: proj.ALPHA, code: 'BETA', name: 'Alpha', billable: 'on' }))
		).toBe('code_exists');
		expect(await code(() => saveProject(who.pm, { projectId: ids.ana, code: 'NEW', name: 'Ghost' }))).toBe('not_found');
		const alpha = await read('pm', (tx, a) => projectView(tx, a, proj.ALPHA));
		expect(alpha?.project).toMatchObject({ code: 'ALPHA', name: 'Alpha', billable: true, status: 'active' });
		const beta = await read('pm', (tx, a) => projectView(tx, a, proj.BETA));
		expect(beta?.project.billable).toBe(false);
	});

	it('keeps each person at or under 100 percent across open projects', async () => {
		expect(await staff('pm', 'ALPHA', 'ana', '60')).toBe('ok');
		expect(await staff('pm', 'BETA', 'ana', '50')).toBe('over_allocated');
		expect(await staff('pm', 'BETA', 'ana', '40')).toBe('ok');
		expect(await staff('pm', 'BETA', 'ana', '41')).toBe('over_allocated');
		expect(await staff('pm', 'ALPHA', 'ana', '55')).toBe('ok');
		expect(await staff('pm', 'ALPHA', 'ben', '100', 'lead')).toBe('ok');
		expect(await staff('pm', 'ALPHA', 'old', '10')).toBe('invalid_employee');
		expect(await staff('pm', 'ALPHA', 'cal', '0')).toBe('invalid: Allocation is 1 to 100 percent.');
		expect(await staff('ana', 'ALPHA', 'cal', '10')).toBe('forbidden');
		expect(await staff('pm', 'GAMMA', 'ana', '10')).toBe('over_allocated');
		expect(await staff('pm', 'BETA', 'cal', '100')).toBe('ok');
		expect(await save('pm', { code: 'BETA', projectId: proj.BETA, status: 'closed' })).toBe('ok');
		expect(await staff('pm', 'GAMMA', 'cal', '100')).toBe('ok');
		expect(await staff('pm', 'BETA', 'cal', '50')).toBe('closed');
		expect(await save('pm', { code: 'BETA', projectId: proj.BETA })).toBe('ok');
		expect(await code(() => removeProjectMember(who.pm, { projectId: proj.GAMMA, employeeId: ids.ben }))).toBe(
			'not_found'
		);
		expect(await code(() => removeProjectMember(who.pm, { projectId: proj.GAMMA, employeeId: ids.cal }))).toBe('ok');
		const team = await read('pm', (tx, a) => projectView(tx, a, proj.ALPHA));
		expect(team?.members.map((x) => `${x.name} ${x.role} ${x.allocation}`)).toEqual(['Ben lead 100', 'Ana member 55']);
	});

	it('shows people only the projects they are on unless they can see all', async () => {
		const codes = async (key: string) => (await read(key, projectList)).map((p) => p.code);
		expect(await codes('pm')).toEqual(['ALPHA', 'BETA', 'GAMMA']);
		expect(await codes('ana')).toEqual(['ALPHA', 'BETA']);
		expect(await codes('cal')).toEqual(['BETA']);
		expect(await read('cal', (tx, a) => projectView(tx, a, proj.ALPHA))).toBeNull();
		expect((await read('ana', (tx, a) => projectView(tx, a, proj.ALPHA)))?.canManage).toBe(false);
		expect((await read('ana', (tx, a) => projectView(tx, a, proj.ALPHA)))?.people).toEqual([]);
	});
});

describe('timesheets', () => {
	it('logs quarter hours on own active projects up to 24 hours a day', async () => {
		expect(await log('ana', 'ALPHA', '2026-11-23', '7.5')).toBe('ok');
		expect(await log('ana', 'ALPHA', '2026-11-23', '8')).toBe('ok');
		expect(await log('ana', 'BETA', '2026-11-23', '16.25')).toBe('day_full');
		expect(await log('ana', 'BETA', '2026-11-23', '16')).toBe('ok');
		expect(await log('ana', 'BETA', '2026-11-24', '1')).toBe('ok');
		expect(await log('ana', 'ALPHA', '2026-11-25', '1')).toBe('future');
		expect(await log('ana', 'GAMMA', '2026-11-24', '1')).toBe('not_member');
		expect(await log('cal', 'ALPHA', '2026-11-24', '1')).toBe('not_member');
		await save('pm', { code: 'BETA', projectId: proj.BETA, status: 'on_hold' });
		expect(await log('ana', 'BETA', '2026-11-24', '1')).toBe('not_member');
		await save('pm', { code: 'BETA', projectId: proj.BETA });
		expect(await log('ana', 'ALPHA', '2026-11-24', '0.1')).toBe(
			'invalid: Log between 0.25 and 24 hours, in quarter hours.'
		);
		expect(await log('ana', 'ALPHA', '2026-11-24', '25')).toBe(
			'invalid: Log between 0.25 and 24 hours, in quarter hours.'
		);
		expect(await log('pm', 'ALPHA', '2026-11-24', '1')).toBe('no_employee');
		expect(await log('ana', 'ALPHA', '2026-11-20', '2')).toBe('ok');
		const w = await week('ana');
		expect(w?.entries.map((e) => `${e.workDate} ${e.code} ${e.minutes}`)).toEqual([
			'2026-11-23 ALPHA 480',
			'2026-11-23 BETA 960',
			'2026-11-24 BETA 60'
		]);
		expect(w?.days).toEqual(['2026-11-22', '2026-11-23', '2026-11-24']);
		expect((await week('ana', '2026-11-18'))?.entries.map((e) => e.workDate)).toEqual(['2026-11-20']);
		expect(await week('pm')).toBeNull();
	});

	it('lets only the owner remove entries while the week is open', async () => {
		const w = await week('ana');
		const beta = w!.entries.find((e) => e.workDate === '2026-11-24')!;
		expect(await code(() => removeEntry(who.ben, { entryId: beta.id }))).toBe('not_found');
		expect(await code(() => removeEntry(who.ana, { entryId: beta.id }))).toBe('ok');
		expect(await code(() => submitWeek(who.cal, { weekStart: WEEK }))).toBe('empty');
		const last = (await week('ana', '2026-11-15'))!.entries[0];
		expect(await code(() => removeEntry(who.ana, { entryId: last.id }))).toBe('ok');
		expect(await code(() => submitWeek(who.ana, { weekStart: '2026-11-15' }))).toBe('empty');
	});

	it('submits the week to the manager and project leads and locks it', async () => {
		const mails = await at(() => submitWeek(who.ana, { weekStart: WEEK }));
		expect(mails.length).toBeGreaterThanOrEqual(0);
		const notified = await withTenant(sys(), (tx) =>
			tx
				.select({ m: notifications.membershipId })
				.from(notifications)
				.where(
					and(
						inArray(notifications.membershipId, [
							who.lea.access.membershipId,
							who.ben.access.membershipId,
							who.ana.access.membershipId
						]),
						eq(notifications.category, 'approvals')
					)
				)
		);
		expect(notified.map((n) => n.m).sort()).toEqual([who.lea.access.membershipId, who.ben.access.membershipId].sort());
		expect(await log('ana', 'ALPHA', '2026-11-24', '1')).toBe('locked');
		const w = await week('ana');
		expect(w?.canEdit).toBe(false);
		expect(await code(() => removeEntry(who.ana, { entryId: w!.entries[0].id }))).toBe('locked');
		expect(await code(() => submitWeek(who.ana, { weekStart: WEEK }))).toBe('locked');
	});

	it('routes the sheet to the manager and project leads only', async () => {
		const sheet = await sheetOf('ana');
		expect(await waiting('lea')).toEqual(['Ana: week of 2026-11-22 · 24 h']);
		expect(await waiting('ben')).toEqual(['Ana: week of 2026-11-22 · 24 h']);
		expect(await waiting('cal')).toEqual([]);
		expect(await waiting('ana')).toEqual([]);
		expect(await read('cal', (tx, a) => timesheetView(tx, a, sheet.id))).toBeNull();
		expect((await read('lea', (tx, a) => timesheetView(tx, a, sheet.id)))?.canDecide).toBe(true);
		expect((await read('ana', (tx, a) => timesheetView(tx, a, sheet.id)))?.canDecide).toBe(false);
	});

	it('sends back with a reason, reopens the week and approves the resubmission', async () => {
		const sheet = await sheetOf('ana');
		expect(await decide('cal', sheet.id, 'approved')).toBe('not_found');
		expect(await decide('ana', sheet.id, 'approved')).toBe('forbidden');
		expect(await decide('ben', sheet.id, 'rejected')).toBe('invalid: Say why the timesheet goes back.');
		expect(await decide('ben', sheet.id, 'rejected', 'Split the Beta hours')).toBe('ok');
		expect(await sheetOf('ana')).toMatchObject({ status: 'rejected', decisionNote: 'Split the Beta hours' });
		expect(await waiting('lea')).toEqual([]);
		expect(await log('ana', 'BETA', '2026-11-23', '15')).toBe('ok');
		expect(await code(() => submitWeek(who.ana, { weekStart: WEEK }))).toBe('ok');
		expect(await sheetOf('ana')).toMatchObject({ status: 'submitted', decisionNote: null, decidedAt: null });
		expect(await decide('lea', sheet.id, 'approved')).toBe('ok');
		expect(await decide('ben', sheet.id, 'approved')).toBe('not_pending');
		expect(await sheetOf('ana')).toMatchObject({ status: 'approved' });
		expect(await log('ana', 'ALPHA', '2026-11-24', '1')).toBe('locked');
		const [mine] = await withTenant(sys(), (tx) =>
			tx
				.select({ n: notifications.title })
				.from(notifications)
				.where(eq(notifications.membershipId, who.ana.access.membershipId))
				.orderBy(notifications.createdAt)
		);
		expect(mine.n).toBe('Your timesheet for the week of 2026-11-22 was sent back');
	});

	it('blocks approving your own sheet unless single-admin approval is on', async () => {
		expect(await log('ben', 'ALPHA', '2026-11-23', '8')).toBe('ok');
		expect(await code(() => submitWeek(who.ben, { weekStart: WEEK }))).toBe('ok');
		const sheet = await sheetOf('ben');
		expect(await waiting('ben')).toEqual([]);
		expect(await waiting('cal')).toEqual(['Ben: week of 2026-11-22 · 8 h']);
		expect((await read('cal', (tx, a) => timesheetView(tx, a, sheet.id)))?.canDecide).toBe(true);
		const selfNotes = await withTenant(sys(), (tx) =>
			tx
				.select({ t: notifications.title })
				.from(notifications)
				.where(eq(notifications.membershipId, who.ben.access.membershipId))
		);
		expect(selfNotes.filter((n) => n.t.startsWith('Ben'))).toEqual([]);
		expect(selfNotes.length).toBe(2);
		expect(await decide('ben', sheet.id, 'approved')).toBe('forbidden');
		expect((await read('ben', (tx, a) => timesheetView(tx, a, sheet.id)))?.canDecide).toBe(false);
		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ allowSingleAdminApproval: true }));
		try {
			expect((await read('ben', (tx, a) => timesheetView(tx, a, sheet.id)))?.canDecide).toBe(true);
			expect(await decide('ben', sheet.id, 'approved')).toBe('ok');
		} finally {
			await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ allowSingleAdminApproval: false }));
		}
		const rows = await withTenant(sys(), (tx) =>
			tx.select({ s: timesheets.status }).from(timesheets).where(eq(timesheets.id, sheet.id))
		);
		expect(rows[0].s).toBe('approved');
	});
});
