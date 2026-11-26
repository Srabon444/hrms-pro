import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	addManualPunch,
	attendanceMonth,
	importPunches,
	punch,
	recomputeAttendance,
	recomputeTenantAttendance,
	teamDay,
	todayPunches
} from '../../src/lib/server/attendance';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import {
	attendanceDays,
	attendancePunches,
	employees,
	holidays,
	leaveTypes,
	memberships
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { cancelLeave, decideLeave, requestLeave } from '../../src/lib/server/leave-requests';
import { addHoliday, removeHoliday } from '../../src/lib/server/org';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { assignShift, createShift, listShifts, removeShiftAssignment } from '../../src/lib/server/shifts';
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
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const local = (iso: string) => `${iso}+06:00`;
const at = <T>(iso: string, fn: () => Promise<T>) => withTestNow(local(iso), fn);
const hourly = (iso: string) => at(iso, () => recomputeTenantAttendance(tenant.id));
const days = (employeeId: string) =>
	withTenant(sys(), async (tx) =>
		Object.fromEntries(
			(
				await tx
					.select()
					.from(attendanceDays)
					.where(eq(attendanceDays.employeeId, employeeId))
					.orderBy(asc(attendanceDays.date))
			).map((d) => [d.date, `${d.status}:${d.workedMinutes}:${d.lateMinutes}`])
		)
	);
const day = async (employeeId: string, date: string) => (await days(employeeId))[date];
const manual = (key: string, employeeId: string, when: string) =>
	code(addManualPunch(who[key], employeeId, { at: when }));

beforeAll(async () => {
	tenant = await createTenant('attendance');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.boss = await hire('Boss');
	ids.staff = await hire('Staff', { managerId: ids.boss });
	ids.owl = await hire('Owl', { managerId: ids.boss });
	ids.peer = await hire('Peer');
	ids.hr = await hire('HR');
	ids.leaver = await hire('Leaver', { status: 'notice' });
	await withTenant(sys(), (tx) =>
		tx.update(employees).set({ exitDate: '2026-03-10' }).where(eq(employees.id, ids.leaver))
	);
	ids.fresh = await hire('Fresh', { joinDate: '2026-03-12', status: 'onboarding' });
	await member('hr', ['hr_admin'], ids.hr);
	await member('boss', ['line_manager'], ids.boss);
	await member('staff', ['employee'], ids.staff);
	await member('owl', ['employee'], ids.owl);
	await member('peer', ['employee'], ids.peer);
	await member('fresh', ['employee'], ids.fresh);
	await createShift(ctx(), {
		name: 'Night',
		startTime: '22:00',
		endTime: '06:00',
		graceMinutes: '10',
		halfDayMinutes: '240',
		fullDayMinutes: '420',
		active: 'on'
	});
	const night = (await withTenant(sys(), listShifts)).find((s) => s.name === 'Night')!;
	ids.night = night.id;
	await assignShift(who.hr, ids.owl, { shiftId: night.id, effectiveFrom: '2026-03-01' });
});

afterAll(closePools);

describe('attendance', () => {
	it('records web punches into a provisional then final day', async () => {
		expect(await at('2026-03-10T09:10:00', () => code(punch(who.staff, '10.0.0.1')))).toBe('ok');
		expect(await day(ids.staff, '2026-03-10')).toBe('present:0:0');
		expect(await at('2026-03-10T09:10:59', () => code(punch(who.staff, null)))).toBe('too_soon');
		const now = await at('2026-03-10T12:00:00', () => withTenant(sys(), (tx) => todayPunches(tx, who.staff.access)));
		expect(now).toMatchObject({ day: '2026-03-10', shift: { name: 'General' }, status: { status: 'present' } });
		expect(now!.punches.map((p) => [p.at.toISOString(), p.source])).toEqual([['2026-03-10T03:10:00.000Z', 'web']]);
		expect(await at('2026-03-10T18:05:00', () => code(punch(who.staff, null)))).toBe('ok');
		expect(await day(ids.staff, '2026-03-10')).toBe('present:535:0');
		const [p] = await withTenant(sys(), (tx) =>
			tx
				.select()
				.from(attendancePunches)
				.where(eq(attendancePunches.employeeId, ids.staff))
				.orderBy(asc(attendancePunches.at))
		);
		expect(p).toMatchObject({ source: 'web', ip: '10.0.0.1', createdByUserId: who.staff.user.userId });

		expect(await at('2026-03-10T09:40:00', () => code(punch(who.peer, null)))).toBe('ok');
		expect(await day(ids.peer, '2026-03-10')).toBe('late:0:40');
		expect(await at('2026-03-10T12:00:00', () => code(punch(who.fresh, null)))).toBe('not_employed');
		expect(await code(punch({ ...who.hr, access: { ...who.hr.access, employeeId: null } } as Member, null))).toBe(
			'no_employee'
		);
	});

	it('marks absence once the shift ends and handles night shifts across midnight', async () => {
		await hourly('2026-03-11T12:00:00');
		expect(await day(ids.staff, '2026-03-11')).toBeUndefined();
		await hourly('2026-03-11T18:00:00');
		expect(await day(ids.staff, '2026-03-11')).toBe('absent:0:0');
		expect(await day(ids.leaver, '2026-03-10')).toBe('absent:0:0');
		expect(await day(ids.leaver, '2026-03-11')).toBeUndefined();
		expect(await day(ids.fresh, '2026-03-11')).toBeUndefined();

		await at('2026-03-10T22:05:00', () => punch(who.owl, null));
		await at('2026-03-11T06:00:00', () => punch(who.owl, null));
		expect(await day(ids.owl, '2026-03-10')).toBe('present:475:0');
		expect(await day(ids.owl, '2026-03-11')).toBeUndefined();
		await hourly('2026-03-12T05:59:00');
		expect(await day(ids.owl, '2026-03-11')).toBeUndefined();
		await hourly('2026-03-12T06:00:00');
		expect(await day(ids.owl, '2026-03-11')).toBe('absent:0:0');
		await hourly('2026-03-12T20:00:00');
		expect(await day(ids.fresh, '2026-03-11')).toBeUndefined();
		expect(await day(ids.fresh, '2026-03-12')).toBe('absent:0:0');
		const later = await at('2026-03-11T10:00:00', () => withTenant(sys(), (tx) => todayPunches(tx, who.staff.access)));
		expect(later).toMatchObject({ day: '2026-03-11', punches: [] });
		const owl = await at('2026-03-11T06:30:00', () => withTenant(sys(), (tx) => todayPunches(tx, who.owl.access)));
		expect(owl).toMatchObject({ day: '2026-03-10', shift: { name: 'Night' } });
		expect(owl!.punches).toHaveLength(2);
		await hourly('2026-03-14T12:00:00');
		expect(await day(ids.staff, '2026-03-13')).toBe('weekend:0:0');
	});

	it('follows holidays added and removed later', async () => {
		await hourly('2026-03-12T20:00:00');
		expect(await day(ids.staff, '2026-03-12')).toBe('absent:0:0');
		await at('2026-03-15T10:00:00', () => addHoliday(ctx(), { date: '2026-03-12', name: 'Shab-e-Barat' }));
		expect(await day(ids.staff, '2026-03-12')).toBe('holiday:0:0');
		expect(await day(ids.owl, '2026-03-12')).toBe('holiday:0:0');
		const [h] = await withTenant(sys(), (tx) => tx.select().from(holidays).where(eq(holidays.date, '2026-03-12')));
		await at('2026-03-15T10:00:00', () => removeHoliday(ctx(), h.id));
		expect(await day(ids.staff, '2026-03-12')).toBe('absent:0:0');
	});

	it('shows approved leave and drops it again when cancelled', async () => {
		const [unpaid] = await withTenant(sys(), (tx) =>
			tx.select({ id: leaveTypes.id }).from(leaveTypes).where(eq(leaveTypes.code, 'unpaid'))
		);
		const ask = (startDate: string) =>
			at('2026-03-15T09:00:00', () => requestLeave(who.staff, { leaveTypeId: unpaid.id, startDate, reason: '' }));
		await ask('2026-03-16');
		await ask('2026-03-18');
		const reqs = await withTenant(sys(), (tx) =>
			tx.execute<{ id: string; start: string }>(
				`select id, start_date::text as start from leave_requests where employee_id = '${ids.staff}' order by start_date`
			)
		);
		await hourly('2026-03-16T20:00:00');
		expect(await day(ids.staff, '2026-03-16')).toBe('absent:0:0');
		await at('2026-03-16T20:00:00', () => decideLeave(who.boss, reqs[0].id, { decision: 'approve', note: '' }));
		expect(await day(ids.staff, '2026-03-16')).toBe('on_leave:0:0');
		await at('2026-03-16T20:00:00', () => decideLeave(who.boss, reqs[1].id, { decision: 'approve', note: '' }));
		expect(await day(ids.staff, '2026-03-18')).toBeUndefined();
		await hourly('2026-03-18T20:00:00');
		expect(await day(ids.staff, '2026-03-18')).toBe('on_leave:0:0');
		await at('2026-03-17T09:00:00', () => cancelLeave(who.staff, reqs[1].id));
		await hourly('2026-03-18T20:00:00');
		expect(await day(ids.staff, '2026-03-18')).toBe('absent:0:0');
	});

	it('lets attendance managers add punches for others', async () => {
		expect(await at('2026-03-20T10:00:00', () => manual('boss', ids.staff, '2026-03-19T09:00'))).toBe('forbidden');
		expect(await at('2026-03-20T10:00:00', () => manual('hr', ids.hr, '2026-03-19T09:00'))).toBe('self_change');
		expect(await at('2026-03-20T10:00:00', () => manual('hr', ids.staff, '2026-03-20T10:01'))).toBe('future');
		expect(await at('2026-03-20T10:00:00', () => manual('hr', ids.staff, 'yesterday'))).toBe('invalid');
		expect(await at('2026-03-20T10:00:00', () => manual('hr', ids.leaver, '2026-03-11T09:00'))).toBe('not_employed');
		expect(await at('2026-03-20T10:00:00', () => manual('hr', ids.staff, '2026-03-19T09:00'))).toBe('ok');
		expect(await at('2026-03-20T10:00:00', () => manual('hr', ids.staff, '2026-03-19T09:00'))).toBe('duplicate');
		expect(await day(ids.staff, '2026-03-19')).toBe('absent:0:0');
		expect(await at('2026-03-20T10:00:00', () => manual('hr', ids.staff, '2026-03-19T17:30'))).toBe('ok');
		expect(await day(ids.staff, '2026-03-19')).toBe('present:510:0');
		const [p] = await withTenant(sys(), (tx) =>
			tx
				.select()
				.from(attendancePunches)
				.where(and(eq(attendancePunches.employeeId, ids.staff), eq(attendancePunches.source, 'manual')))
				.orderBy(asc(attendancePunches.at))
		);
		expect(p.at.toISOString()).toBe('2026-03-19T03:00:00.000Z');
		expect(p.createdByUserId).toBe(who.hr.user.userId);
	});

	it('recomputes past days when a shift assignment changes', async () => {
		await assignShift(who.hr, ids.staff, { shiftId: ids.night, effectiveFrom: '2026-03-12' });
		await withTenant(sys(), (tx) => recomputeAttendance(tx, tenant.id, '2026-03-10', '2026-03-12', [ids.staff]));
		expect(await day(ids.staff, '2026-03-10')).toBe('present:535:0');
		await removeShiftAssignment(
			who.hr,
			ids.staff,
			(
				await withTenant(sys(), (tx) =>
					tx.execute<{ id: string }>(`select id from shift_assignments where employee_id = '${ids.staff}'`)
				)
			)[0].id
		);
		await assignShift(who.hr, ids.staff, { shiftId: ids.night, effectiveFrom: '2026-03-10' });
		expect(await day(ids.staff, '2026-03-10')).toBe('absent:0:0');
		expect(await day(ids.staff, '2026-03-12')).toBe('absent:0:0');
		const [a] = await withTenant(sys(), (tx) =>
			tx.execute<{ id: string }>(`select id from shift_assignments where employee_id = '${ids.staff}'`)
		);
		await removeShiftAssignment(who.hr, ids.staff, a.id);
		expect(await day(ids.staff, '2026-03-10')).toBe('present:535:0');
		expect(await day(ids.staff, '2026-03-16')).toBe('on_leave:0:0');
	});

	it('scopes the month and team views', async () => {
		const month = (key: string, employeeId: string, m?: string) =>
			withTenant(sys(), (tx) => attendanceMonth(tx, who[key].access, employeeId, m));
		const mine = await at('2026-03-20T10:00:00', () => month('staff', ids.staff));
		expect(mine?.month).toBe('2026-03');
		expect(mine!.days.slice(0, 3).map((d) => [d.date, d.status])).toEqual([
			['2026-03-09', 'absent'],
			['2026-03-10', 'present'],
			['2026-03-11', 'absent']
		]);
		expect((await month('staff', ids.staff, '2026-02'))!.days).toEqual([]);
		expect((await month('staff', ids.staff, '2026-13'))!.month).toBe(new Date().toISOString().slice(0, 7));
		expect(await month('peer', ids.staff)).toBeNull();
		expect((await month('boss', ids.staff, '2026-03'))!.days.length).toBeGreaterThan(3);

		const team = async (key: string) =>
			(await withTenant(sys(), (tx) => teamDay(tx, who[key].access, '2026-03-10'))).map((r) => [r.fullName, r.status]);
		expect(await team('boss')).toEqual([
			['Boss', 'absent'],
			['Owl', 'present'],
			['Staff', 'present']
		]);
		expect(
			(await withTenant(sys(), (tx) => teamDay(tx, who.hr.access, '2026-03-11'))).map((r) => r.fullName)
		).not.toContain('Leaver');
		expect(await team('hr')).toEqual([
			['Boss', 'absent'],
			['HR', 'absent'],
			['Leaver', 'absent'],
			['Owl', 'present'],
			['Peer', 'absent'],
			['Staff', 'present']
		]);
	});
});

describe('device punch import', () => {
	const codes = () =>
		withTenant(sys(), async (tx) =>
			Object.fromEntries(
				(await tx.select({ id: employees.id, code: employees.code }).from(employees)).map((e) => [e.id, e.code])
			)
		);
	const run = (key: string, rows: string[][]) =>
		at('2026-03-25T10:00:00', () => importPunches(who[key], rows)).catch(
			(e: { code?: string; rows?: { line: number; message: string }[] }) => ({ code: e.code, rows: e.rows })
		);
	const count = () => withTenant(sys(), async (tx) => (await tx.select().from(attendancePunches)).length);

	it('adds device punches once and recomputes the days they touch', async () => {
		const c = await codes();
		const file = [
			['Employee_Code', 'timestamp'],
			[c[ids.staff].toLowerCase(), '2026-03-23 09:00'],
			[c[ids.staff], '2026-03-23T18:00:30'],
			[c[ids.staff], '2026-03-23 09:00'],
			[c[ids.owl], '2026-03-23T22:00:00+06:00'],
			[c[ids.owl], '2026-03-24 06:00']
		];
		expect(await run('hr', file)).toEqual({ added: 4, skipped: 1 });
		expect(await day(ids.staff, '2026-03-23')).toBe('present:540:0');
		expect(await day(ids.owl, '2026-03-23')).toBe('present:480:0');
		const [p] = await withTenant(sys(), (tx) =>
			tx
				.select()
				.from(attendancePunches)
				.where(and(eq(attendancePunches.employeeId, ids.staff), eq(attendancePunches.source, 'device')))
				.orderBy(asc(attendancePunches.at))
				.offset(1)
		);
		expect(p.at.toISOString()).toBe('2026-03-23T12:00:30.000Z');
		expect(await run('hr', file)).toEqual({ added: 0, skipped: 5 });
		const header = ['employee_code', 'timestamp'];
		expect(await run('hr', [header, [c[ids.owl], '2026-03-24 22:00']])).toEqual({ added: 1, skipped: 0 });
		expect(await day(ids.owl, '2026-03-24')).toBe('absent:0:0');
		expect(await run('hr', [header, [c[ids.owl], '2026-03-25 06:00']])).toEqual({ added: 1, skipped: 0 });
		expect(await day(ids.owl, '2026-03-24')).toBe('present:480:0');
	});

	it('imports nothing when any row is wrong', async () => {
		const c = await codes();
		const before = await count();
		expect(await run('hr', [['code', 'when']])).toMatchObject({ code: 'import_failed', rows: [{ line: 1 }] });
		expect(await run('hr', [['employee_code', 'timestamp', 'device']])).toMatchObject({
			code: 'import_failed',
			rows: [{ line: 1 }]
		});
		expect(await run('hr', [['employee_code', 'timestamp']])).toMatchObject({
			code: 'import_failed',
			rows: [{ line: 2 }]
		});
		const bad = await run('hr', [
			['timestamp', 'employee_code'],
			['2026-03-24 09:00', c[ids.peer]],
			['2026-03-24 09:00', 'NOPE-1'],
			['24/03/2026 09:00', c[ids.peer]],
			['2026-03-26 09:00', c[ids.peer]],
			['2026-03-11 09:00', c[ids.fresh]],
			['2026-03-12 09:00', c[ids.leaver]],
			['2026-03-24 09:00', c[ids.hr]]
		]);
		expect(bad).toEqual({
			code: 'import_failed',
			rows: [
				{ line: 3, message: 'Unknown employee code.' },
				{ line: 4, message: 'Use a timestamp like 2026-03-10 09:05 or 2026-03-10T09:05:00+06:00.' },
				{ line: 5, message: 'A punch cannot be in the future.' },
				{ line: 6, message: "The punch falls outside this person's employment." },
				{ line: 7, message: "The punch falls outside this person's employment." },
				{ line: 8, message: 'Someone else has to import your own punches.' }
			]
		});
		expect(
			await run('boss', [
				['employee_code', 'timestamp'],
				[c[ids.staff], '2026-03-24 09:00']
			])
		).toMatchObject({
			code: 'import_failed',
			rows: [{ line: 2, message: 'Unknown employee code.' }]
		});
		expect(await count()).toBe(before);
		expect(
			await run('hr', [
				['employee_code', 'timestamp'],
				[c[ids.leaver], '2026-03-11 05:00']
			])
		).toEqual({
			added: 1,
			skipped: 0
		});
	});
});
