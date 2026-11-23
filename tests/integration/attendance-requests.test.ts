import { and, asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addManualPunch, recomputeTenantAttendance } from '../../src/lib/server/attendance';
import {
	attendanceApprovals,
	cancelAttendanceRequest,
	decideAttendance,
	getAttendanceRequest,
	myAttendanceRequests,
	requestAttendance
} from '../../src/lib/server/attendance-requests';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import {
	attendanceDays,
	attendancePunches,
	attendanceRequests,
	memberships,
	holidays,
	notifications,
	rolePermissions,
	roles,
	tenantSettings
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { assignShift, createShift, listShifts } from '../../src/lib/server/shifts';
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
		joinDate: '2026-01-01',
		...extra
	});

async function member(key: string, roleKeys: string[], employeeId: string) {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	ids[`m:${key}`] = id;
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const at = <T>(iso: string, fn: () => Promise<T>) => withTestNow(`${iso}+06:00`, fn);
const LATER = '2026-03-20T10:00:00';
const later = <T>(fn: () => Promise<T>) => at(LATER, fn);
const ask = (key: string, raw: Record<string, string>) => later(() => code(requestAttendance(who[key], raw)));
const decide = (key: string, id: string, raw: Record<string, string>) =>
	later(() => code(decideAttendance(who[key], id, raw)));
const punchAt = (employeeId: string, when: string) =>
	later(() => code(addManualPunch(who.hr, employeeId, { at: when })));
const day = (employeeId: string, date: string) =>
	withTenant(sys(), async (tx) => {
		const [d] = await tx
			.select()
			.from(attendanceDays)
			.where(and(eq(attendanceDays.employeeId, employeeId), eq(attendanceDays.date, date)));
		return d ? `${d.status}:${d.workedMinutes}` : null;
	});
const latest = (employeeId: string) =>
	withTenant(sys(), async (tx) => {
		const [r] = await tx
			.select()
			.from(attendanceRequests)
			.where(eq(attendanceRequests.employeeId, employeeId))
			.orderBy(desc(attendanceRequests.createdAt))
			.limit(1);
		return r;
	});
const inbox = (key: string) =>
	later(() => withTenant(sys(), (tx) => attendanceApprovals(tx, who[key].access))).then((l) => l.map((i) => i.title));

beforeAll(async () => {
	tenant = await createTenant('attendance-requests');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.boss = await hire('Boss');
	ids.staff = await hire('Staff', { managerId: ids.boss });
	ids.owl = await hire('Owl', { managerId: ids.boss });
	ids.peer = await hire('Peer');
	ids.hr = await hire('HR');
	await member('hr', ['hr_admin'], ids.hr);
	await member('hr2', ['hr_admin'], await hire('HR Two'));
	await member('boss', ['line_manager'], ids.boss);
	await member('staff', ['employee'], ids.staff);
	await member('owl', ['employee'], ids.owl);
	await member('peer', ['employee'], ids.peer);
	await withTenant(sys(), async (tx) => {
		const [role] = await tx
			.insert(roles)
			.values({ tenantId: tenant.id, key: 'leave_desk', name: 'Leave desk' })
			.returning({ id: roles.id });
		await tx.insert(rolePermissions).values(
			['leave.approve', 'leave.manage'].map((permission) => ({
				tenantId: tenant.id,
				roleId: role.id,
				permission,
				scope: 'all'
			}))
		);
		await tx.insert(holidays).values({ tenantId: tenant.id, date: '2026-03-26', name: 'Independence Day' });
	});
	await member('desk', ['leave_desk'], await hire('Desk'));
	await createShift(
		{ tenantId: tenant.id, actor: 'user' },
		{
			name: 'Night',
			startTime: '22:00',
			endTime: '06:00',
			graceMinutes: '10',
			halfDayMinutes: '240',
			fullDayMinutes: '420',
			active: 'on'
		}
	);
	const night = (await withTenant(sys(), listShifts)).find((s) => s.name === 'Night')!;
	await assignShift(who.hr, ids.owl, { shiftId: night.id, effectiveFrom: '2026-03-01' });
});

afterAll(closePools);

describe('attendance requests', () => {
	it('turns an approved missed punch into a regularization punch', async () => {
		expect(await punchAt(ids.staff, '2026-03-10T09:00')).toBe('ok');
		await later(() => recomputeTenantAttendance(tenant.id));
		expect(await day(ids.staff, '2026-03-10')).toBe('absent:0');
		const reason = 'Forgot to punch out';
		expect(await ask('staff', { kind: 'regularization', at: '2026-03-10T18:00', reason: '' })).toBe('invalid');
		expect(await ask('staff', { kind: 'regularization', at: '2026-03-10T09:00', reason })).toBe('duplicate');
		expect(await ask('staff', { kind: 'regularization', at: '2026-03-21T09:00', reason })).toBe('future');
		expect(await ask('staff', { kind: 'regularization', at: '2025-12-31T18:00', reason })).toBe('not_employed');
		expect(await ask('staff', { kind: 'regularization', at: '2026-03-10T18:00', reason })).toBe('ok');
		expect(await ask('staff', { kind: 'regularization', at: '2026-03-10T18:00', reason })).toBe('overlap');
		const r = await latest(ids.staff);
		expect(r).toMatchObject({ kind: 'regularization', date: '2026-03-10', status: 'pending' });
		expect(await inbox('boss')).toEqual(['Staff: Missed punch at 2026-03-10 18:00']);
		expect(await inbox('hr')).toEqual(['Staff: Missed punch at 2026-03-10 18:00']);
		expect(await inbox('peer')).toEqual([]);
		const told = await withTenant(sys(), (tx) =>
			tx.select({ m: notifications.membershipId, link: notifications.link }).from(notifications)
		);
		expect(told).toEqual([{ m: ids['m:boss'], link: `approvals/attendance/${r.id}` }]);
		expect(await decide('peer', r.id, { decision: 'approve' })).toBe('not_found');
		expect(await decide('staff', r.id, { decision: 'approve' })).toBe('self_approval');
		expect(await decide('boss', r.id, { decision: 'approve' })).toBe('ok');
		expect(await decide('boss', r.id, { decision: 'approve' })).toBe('already_decided');
		expect(await day(ids.staff, '2026-03-10')).toBe('present:540');
		const sources = await withTenant(sys(), (tx) =>
			tx
				.select({ source: attendancePunches.source })
				.from(attendancePunches)
				.where(eq(attendancePunches.employeeId, ids.staff))
				.orderBy(asc(attendancePunches.at))
		);
		expect(sources.map((s) => s.source)).toEqual(['manual', 'regularization']);
		expect(await later(() => code(cancelAttendanceRequest(who.staff, r.id)))).toBe('not_cancellable');
	});

	it('places an overnight missed punch on the day the shift started', async () => {
		expect(await punchAt(ids.owl, '2026-03-10T22:00')).toBe('ok');
		expect(await ask('owl', { kind: 'regularization', at: '2026-03-11T06:05', reason: 'Gate reader down' })).toBe('ok');
		const r = await latest(ids.owl);
		expect(r.date).toBe('2026-03-10');
		expect(await ask('owl', { kind: 'regularization', at: '2026-03-11T22:00', reason: 'Badge lost' })).toBe('ok');
		expect(await ask('owl', { kind: 'regularization', at: '2026-03-12T06:00', reason: 'Badge lost' })).toBe('ok');
		expect(await decide('hr', r.id, { decision: 'approve' })).toBe('ok');
		expect(await day(ids.owl, '2026-03-10')).toBe('present:485');
	});

	it('marks approved work from home days and lets an upcoming one be cancelled', async () => {
		const reason = 'Plumber visit';
		expect(await ask('staff', { kind: 'wfh', date: '2026-03-13', reason })).toBe('not_working_day');
		expect(await ask('staff', { kind: 'wfh', date: '2026-03-26', reason })).toBe('not_working_day');
		expect(await ask('staff', { kind: 'wfh', date: '2025-12-01', reason })).toBe('not_employed');
		expect(await ask('staff', { kind: 'wfh', date: '2026-03-12', reason })).toBe('ok');
		const past = await latest(ids.staff);
		expect(await day(ids.staff, '2026-03-12')).toBe(null);
		expect(await decide('boss', past.id, { decision: 'approve' })).toBe('ok');
		expect(await day(ids.staff, '2026-03-12')).toBe('wfh:0');

		expect(await ask('staff', { kind: 'wfh', date: '2026-03-23', reason })).toBe('ok');
		const next = await latest(ids.staff);
		expect(await decide('boss', next.id, { decision: 'approve' })).toBe('ok');
		expect(await at('2026-03-23T10:00:00', () => recomputeTenantAttendance(tenant.id)).then(() => null)).toBe(null);
		expect(await day(ids.staff, '2026-03-23')).toBe('wfh:0');
		const mine = await later(() => withTenant(sys(), (tx) => myAttendanceRequests(tx, who.staff.access)));
		expect(mine.find((m) => m.id === next.id)).toMatchObject({ status: 'approved', cancellable: true });
		expect(mine.find((m) => m.id === past.id)).toMatchObject({ cancellable: false });
		expect(await later(() => code(cancelAttendanceRequest(who.peer, next.id)))).toBe('not_found');
		expect(await later(() => code(cancelAttendanceRequest(who.boss, next.id)))).toBe('forbidden');
		expect(await ask('staff', { kind: 'wfh', date: '2026-03-19', reason })).toBe('ok');
		const pending = await latest(ids.staff);
		expect(await later(() => code(cancelAttendanceRequest(who.staff, pending.id)))).toBe('ok');
		expect((await latest(ids.staff)).status).toBe('cancelled');
		expect(await later(() => code(cancelAttendanceRequest(who.staff, next.id)))).toBe('ok');
		await at('2026-03-23T19:00:00', () => recomputeTenantAttendance(tenant.id));
		expect(await day(ids.staff, '2026-03-23')).toBe('absent:0');
	});

	it('approves overtime only up to the recorded extra time, the daily cap and 15 minute steps', async () => {
		const reason = 'Release night';
		expect(await ask('staff', { kind: 'overtime', date: '2026-03-10', minutes: '10', reason })).toBe('invalid');
		expect(await ask('staff', { kind: 'overtime', date: '2026-03-21', minutes: '60', reason })).toBe('future');
		expect(await ask('staff', { kind: 'overtime', date: '2026-03-10', minutes: '120', reason })).toBe('ok');
		expect(await ask('staff', { kind: 'overtime', date: '2026-03-10', minutes: '30', reason })).toBe('overlap');
		const tenth = await latest(ids.staff);
		const view = await later(() => withTenant(sys(), (tx) => getAttendanceRequest(tx, who.boss.access, tenth.id)));
		expect(view).toMatchObject({ canDecide: true, day: { status: 'present', workedMinutes: 540, extraMinutes: 60 } });
		expect(await decide('boss', tenth.id, { decision: 'approve' })).toBe('ok');
		expect((await latest(ids.staff)).approvedMinutes).toBe(60);

		expect(await punchAt(ids.staff, '2026-03-16T09:00')).toBe('ok');
		expect(await punchAt(ids.staff, '2026-03-16T21:00')).toBe('ok');
		expect(await ask('staff', { kind: 'overtime', date: '2026-03-16', minutes: '240', reason })).toBe('ok');
		const capped = await latest(ids.staff);
		expect(await decide('boss', capped.id, { decision: 'approve' })).toBe('ok');
		expect((await latest(ids.staff)).approvedMinutes).toBe(120);

		expect(await punchAt(ids.staff, '2026-03-14T10:00')).toBe('ok');
		expect(await punchAt(ids.staff, '2026-03-14T16:10')).toBe('ok');
		expect(await day(ids.staff, '2026-03-14')).toBe('weekend:370');
		expect(await ask('staff', { kind: 'overtime', date: '2026-03-14', minutes: '400', reason })).toBe('ok');
		const weekend = await latest(ids.staff);
		expect(await decide('boss', weekend.id, { decision: 'approve' })).toBe('ok');
		expect((await latest(ids.staff)).approvedMinutes).toBe(360);

		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ overtimeDailyCapMinutes: 720 }));
		expect(await punchAt(ids.staff, '2026-03-17T09:00')).toBe('ok');
		expect(await punchAt(ids.staff, '2026-03-17T21:00')).toBe('ok');
		expect(await ask('staff', { kind: 'overtime', date: '2026-03-17', minutes: '240', reason })).toBe('ok');
		const trimmed = await latest(ids.staff);
		expect(await decide('boss', trimmed.id, { decision: 'approve', minutes: '5' })).toBe('invalid');
		expect(await decide('boss', trimmed.id, { decision: 'approve', minutes: '50' })).toBe('ok');
		expect((await latest(ids.staff)).approvedMinutes).toBe(45);

		expect(await ask('staff', { kind: 'overtime', date: '2026-03-18', minutes: '60', reason })).toBe('ok');
		const none = await latest(ids.staff);
		expect(await decide('boss', none.id, { decision: 'approve' })).toBe('no_overtime');
		expect(await decide('boss', none.id, { decision: 'reject', note: 'No punches that day' })).toBe('ok');
		expect(await latest(ids.staff)).toMatchObject({
			status: 'rejected',
			approvedMinutes: null,
			decisionNote: 'No punches that day'
		});
	});

	it('sends an approver without a manager to other HR and never to the requester', async () => {
		expect(await ask('hr', { kind: 'wfh', date: '2026-03-19', reason: 'Internet install' })).toBe('ok');
		const r = await latest(ids.hr);
		expect(await inbox('hr')).not.toContain('HR: Work from home on 2026-03-19');
		expect(await inbox('hr2')).toContain('HR: Work from home on 2026-03-19');
		const told = await withTenant(sys(), (tx) =>
			tx
				.select({ m: notifications.membershipId })
				.from(notifications)
				.where(eq(notifications.link, `approvals/attendance/${r.id}`))
		);
		expect(told.map((t) => t.m)).toEqual([ids['m:hr2']]);
		expect(await decide('hr', r.id, { decision: 'approve' })).toBe('self_approval');
		expect(await decide('hr2', r.id, { decision: 'approve' })).toBe('ok');
	});
});
