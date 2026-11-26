import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recomputeAttendance } from '../../src/lib/server/attendance';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { attendanceDays, leaveTypes, memberships, rosterEntries } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { decideLeave, requestLeave } from '../../src/lib/server/leave-requests';
import { addHoliday } from '../../src/lib/server/org';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { closeQueues } from '../../src/lib/server/queue';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import {
	addAvailability,
	copyWeek,
	myAvailability,
	publishWeek,
	removeAvailability,
	removeEntry,
	saveEntry,
	scheduleWeek
} from '../../src/lib/server/schedule';
import { createShift, listShifts } from '../../src/lib/server/shifts';
import { systemCtx, withTenant, type Tx } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const shift: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const db = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(sys(), fn);
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
	createEmployee(ctx(), creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01',
		...extra
	});

async function member(key: string, roleKeys: string[], employeeId: string) {
	const u = await createUser();
	const id = await db(async (tx) => {
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

const early = <T>(fn: () => Promise<T>) => withTestNow('2026-03-01T09:00:00+06:00', fn);
const settle = () =>
	withTestNow('2026-03-25T12:00:00+06:00', () =>
		db((tx) => recomputeAttendance(tx, tenant.id, '2026-03-01', '2026-03-21'))
	);
const status = async (employeeId: string, date: string) => {
	const [d] = await db((tx) =>
		tx
			.select()
			.from(attendanceDays)
			.where(and(eq(attendanceDays.employeeId, employeeId), eq(attendanceDays.date, date)))
	);
	return d ? `${d.status}:${d.workedMinutes}` : undefined;
};
const save = (key: string, person: string, date: string, kind: string, shiftName = 'General') =>
	code(early(() => saveEntry(who[key], { employeeId: ids[person], date, kind, shiftId: shift[shiftName], note: '' })));
const publish = (key: string, week: string) => early(() => publishWeek(who[key], week));
const grid = (key: string, week: string) => early(() => db((tx) => scheduleWeek(tx, who[key].access, week)));
const cell = async (key: string, person: string, date: string) =>
	(await grid(key, date)).rows.find((r) => r.id === ids[person])?.cells.find((c) => c.date === date);
const entryId = async (person: string, date: string) =>
	(
		await db((tx) =>
			tx
				.select({ id: rosterEntries.id })
				.from(rosterEntries)
				.where(and(eq(rosterEntries.employeeId, ids[person]), eq(rosterEntries.date, date)))
		)
	)[0]?.id;

async function leave(key: string, date: string) {
	const [unpaid] = await db((tx) => tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'unpaid')));
	await early(() =>
		requestLeave(who[key], { leaveTypeId: unpaid.id, startDate: date, endDate: date, session: 'full', reason: '' }, [])
	);
	const [r] = await ownerPool().sql<{ id: string }[]>`
		select id from leave_requests where employee_id = ${ids[key]} order by created_at desc limit 1`;
	await early(() => decideLeave(who.hr, r.id, { decision: 'approve', note: '' }));
	return r.id;
}

const leaveDays = async (requestId: string) =>
	(
		await ownerPool().sql<{ n: string }[]>`
			select count(*) as n from leave_request_days where request_id = ${requestId} and status = 'approved'`
	)[0].n;

beforeAll(async () => {
	tenant = await createTenant('schedule');
	await db((tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.hr = await hire('Sc Hr');
	ids.lee = await hire('Sc Lee');
	ids.ana = await hire('Sc Ana', { managerId: ids.lee });
	ids.ben = await hire('Sc Ben', { managerId: ids.lee });
	ids.cal = await hire('Sc Cal');
	ids.owl = await hire('Sc Owl');
	ids.dan = await hire('Sc Dan');
	await member('hr', ['hr_admin'], ids.hr);
	await member('lee', ['line_manager'], ids.lee);
	await member('ana', ['employee'], ids.ana);
	await member('ben', ['employee'], ids.ben);
	await createShift(ctx(), {
		name: 'Night',
		startTime: '22:00',
		endTime: '06:00',
		graceMinutes: '10',
		halfDayMinutes: '240',
		fullDayMinutes: '420',
		active: 'on'
	});
	for (const s of await db(listShifts)) shift[s.name] = s.id;
	const [roster] = await ownerPool().sql<{ id: string }[]>`
		insert into work_weeks (tenant_id, name, weekend_days, roster_mode) values (${tenant.id}, 'Rota', '{5,6}', true)
		returning id`;
	await ownerPool().sql`
		insert into work_week_assignments (tenant_id, employee_id, work_week_id, effective_from)
		values (${tenant.id}, ${ids.ben}, ${roster.id}, '2026-01-01')`;
});

afterAll(async () => {
	await closeQueues();
	await closePools();
});

describe('schedule', () => {
	it('keeps drafts from staff until published, then works a rostered weekend', async () => {
		expect(await save('hr', 'ana', '2026-03-13', 'work')).toBe('ok');
		expect((await cell('ana', 'ana', '2026-03-13'))?.entry).toBeNull();
		expect((await cell('hr', 'ana', '2026-03-13'))?.entry).toMatchObject({ status: 'draft', kind: 'work' });
		expect((await grid('hr', '2026-03-08')).drafts).toBe(1);
		await settle();
		expect(await status(ids.ana, '2026-03-13')).toBe('weekend:0');

		expect(await publish('hr', '2026-03-10')).toEqual({ published: 1, noRest: [] });
		expect(await code(publish('hr', '2026-03-10'))).toBe('nothing_to_publish');
		await settle();
		expect(await status(ids.ana, '2026-03-13')).toBe('absent:0');
		expect((await cell('ana', 'ana', '2026-03-13'))?.entry).toMatchObject({ status: 'published' });
		const sent = await ownerPool().sql<{ link: string }[]>`
			select n.link from notifications n join memberships m on m.id = n.membership_id
			where m.employee_id = ${ids.ana} and n.category = 'schedule'`;
		expect(sent.map((s) => s.link)).toEqual(['schedule?week=2026-03-08']);
	});

	it('rests a rostered day off, lets leave win on it and leaves the leave days alone', async () => {
		const request = await leave('ana', '2026-03-10');
		expect(await leaveDays(request)).toBe('1');
		expect(await save('hr', 'ana', '2026-03-09', 'off')).toBe('ok');
		expect(await save('hr', 'ana', '2026-03-10', 'off')).toBe('ok');
		expect(await publish('hr', '2026-03-08')).toMatchObject({ published: 2 });
		await settle();
		expect(await status(ids.ana, '2026-03-09')).toBe('weekend:0');
		expect(await status(ids.ana, '2026-03-10')).toBe('on_leave:0');
		expect(await leaveDays(request)).toBe('1');
	});

	it('refuses a shift over leave', async () => {
		await leave('ana', '2026-03-11');
		expect(await save('hr', 'ana', '2026-03-11', 'work')).toBe('ok');
		expect(await code(publish('hr', '2026-03-08'))).toBe('leave_conflict');
		expect((await cell('hr', 'ana', '2026-03-11'))?.conflicts).toEqual(['On leave that day']);
		expect(await code(early(() => removeEntry(who.hr, crypto.randomUUID())))).toBe('not_found');
		expect(await code(early(async () => removeEntry(who.hr, (await entryId('ana', '2026-03-11'))!)))).toBe('ok');
		expect(await save('hr', 'ana', '2026-03-10', 'work')).toBe('leave_conflict');
	});

	it('keeps a holiday a holiday on a rostered day', async () => {
		await early(() => addHoliday(ctx(), { date: '2026-03-12', name: 'Spring day' }));
		expect(await save('hr', 'ana', '2026-03-12', 'work')).toBe('ok');
		await publish('hr', '2026-03-08');
		await settle();
		expect(await status(ids.ana, '2026-03-12')).toBe('holiday:0');
		expect((await grid('hr', '2026-03-08')).days.find((d) => d.date === '2026-03-12')?.holiday).toBe('Spring day');
	});

	it('rests people on a rostered work week unless the schedule gives them a shift', async () => {
		await settle();
		expect(await status(ids.ben, '2026-03-09')).toBe('weekend:0');
		expect(await status(ids.ben, '2026-03-16')).toBe('weekend:0');
		expect(await save('hr', 'ben', '2026-03-09', 'work')).toBe('ok');
		await publish('hr', '2026-03-08');
		await leave('ben', '2026-03-16');
		await settle();
		expect(await status(ids.ben, '2026-03-09')).toBe('absent:0');
		expect(await status(ids.ben, '2026-03-16')).toBe('on_leave:0');
	});

	it('follows a rostered night shift across midnight and warns about a week without rest', async () => {
		for (let d = 8; d <= 14; d++)
			expect(await save('hr', 'owl', `2026-03-${String(d).padStart(2, '0')}`, 'work', 'Night')).toBe('ok');
		expect(await publish('hr', '2026-03-08')).toEqual({ published: 7, noRest: ['Sc Owl'] });
		await ownerPool().sql`
			insert into attendance_punches (tenant_id, employee_id, at, source)
			values (${tenant.id}, ${ids.owl}, '2026-03-11T22:05:00+06:00', 'manual'),
				(${tenant.id}, ${ids.owl}, '2026-03-12T06:00:00+06:00', 'manual')`;
		await settle();
		expect(await status(ids.owl, '2026-03-11')).toBe('present:475');
		expect(await status(ids.owl, '2026-03-13')).toBe('absent:0');
	});

	it('refuses days in a month whose payroll is approved', async () => {
		await ownerPool().sql`
			insert into payroll_runs (tenant_id, run_type, period, status, inputs_hash, output_hash, computed_by_user_id, computed_at)
			values (${tenant.id}, 'regular', '2026-02', 'approved', 'x', 'x', ${who.hr.user.userId}, now())`;
		expect(await save('hr', 'cal', '2026-02-16', 'work')).toBe('payroll_closed');
		expect(await save('hr', 'cal', '2025-12-30', 'work')).toBe('not_employed');
		expect(await save('hr', 'cal', '2026-03-16', 'work')).toBe('ok');
	});

	it('lets a line manager schedule only their team', async () => {
		const week = await grid('lee', '2026-03-15');
		expect(week.rows.map((r) => r.name)).toEqual(['Sc Ana', 'Sc Ben', 'Sc Lee']);
		expect(week.drafts).toBe(0);
		expect(await save('lee', 'cal', '2026-03-17', 'work')).not.toBe('ok');
		expect(await save('ana', 'ana', '2026-03-17', 'work')).toBe('forbidden');
		expect(await save('lee', 'ana', '2026-03-14', 'work')).toBe('ok');
		expect(await save('hr', 'ana', '2026-03-14', 'work', 'Missing')).toBe('invalid');
		expect((await grid('ana', '2026-03-15')).rows.map((r) => r.name)).toEqual(['Sc Ana']);
		expect((await grid('ana', '2026-03-15')).canManage).toBe(false);
	});

	it('copies last week as drafts without overwriting what is there', async () => {
		expect(await save('hr', 'ana', '2026-03-20', 'off')).toBe('ok');
		const before = await ownerPool().sql<{ n: string }[]>`
			select count(*) as n from roster_entries where tenant_id = ${tenant.id} and date between '2026-03-08' and '2026-03-14'`;
		const copied = await early(() => copyWeek(who.hr, '2026-03-15'));
		expect(copied).toBe(Number(before[0].n) - 1);
		const target = await db((tx) =>
			tx
				.select()
				.from(rosterEntries)
				.where(and(eq(rosterEntries.employeeId, ids.ana), eq(rosterEntries.date, '2026-03-20')))
		);
		expect(target.map((t) => t.kind)).toEqual(['off']);
		expect(await early(() => copyWeek(who.hr, '2026-03-15'))).toBe(0);
		const drafts = await ownerPool().sql<{ status: string }[]>`
			select distinct status from roster_entries where tenant_id = ${tenant.id} and date between '2026-03-15' and '2026-03-21'`;
		expect(drafts.map((d) => d.status)).toEqual(['draft']);
	});

	it('shows unavailable times to managers and flags shifts during them', async () => {
		expect(
			await code(
				early(() => addAvailability(who.ana, { when: 'weekday', weekday: '3', fromTime: '08:00', toTime: '10:00' }))
			)
		).toBe('ok');
		expect(
			await code(
				early(() => addAvailability(who.ana, { when: 'date', date: '2026-03-19', fromTime: '10:00', toTime: '09:00' }))
			)
		).toBe('invalid');
		expect(
			await code(
				early(() => addAvailability(who.ana, { when: 'weekday', weekday: '7', fromTime: '08:00', toTime: '10:00' }))
			)
		).toBe('invalid');
		expect(await save('hr', 'ana', '2026-03-18', 'work')).toBe('ok');
		const c = await cell('lee', 'ana', '2026-03-18');
		expect(c?.unavailable).toEqual([{ from: '08:00', to: '10:00', note: null }]);
		expect(c?.conflicts).toEqual(['Marked unavailable']);
		const [mine] = (await db((tx) => myAvailability(tx, who.ana.access)))!;
		expect(await code(early(() => removeAvailability(who.ben, mine.id)))).toBe('not_found');
		expect(await code(early(() => removeAvailability(who.ana, mine.id)))).toBe('ok');
		expect((await cell('lee', 'ana', '2026-03-18'))?.conflicts).toEqual([]);
	});

	it('copies nothing into a closed payroll month and still lets a stray draft there go', async () => {
		await ownerPool().sql`
			insert into roster_entries (tenant_id, employee_id, date, shift_id, kind, status, published_at)
			values (${tenant.id}, ${ids.cal}, '2026-01-26', ${shift.General}, 'work', 'published', now()),
				(${tenant.id}, ${ids.cal}, '2026-02-03', ${shift.General}, 'work', 'draft', null)`;
		expect(await early(() => copyWeek(who.hr, '2026-02-01'))).toBe(0);
		expect(await code(early(async () => removeEntry(who.hr, (await entryId('cal', '2026-02-03'))!)))).toBe('ok');
		expect(await code(early(async () => removeEntry(who.hr, (await entryId('cal', '2026-01-26'))!)))).toBe('ok');
	});

	it('checks the shift and the employment again when publishing', async () => {
		await createShift(ctx(), {
			name: 'Temp',
			startTime: '10:00',
			endTime: '16:00',
			graceMinutes: '10',
			halfDayMinutes: '120',
			fullDayMinutes: '300',
			active: 'on'
		});
		for (const s of await db(listShifts)) shift[s.name] = s.id;
		expect(await save('hr', 'dan', '2026-04-06', 'work', 'Temp')).toBe('ok');
		await ownerPool().sql`update shifts set active = false where id = ${shift.Temp}`;
		expect(await code(publish('hr', '2026-04-05'))).toBe('unknown_shift');
		expect(await code(early(async () => removeEntry(who.hr, (await entryId('dan', '2026-04-06'))!)))).toBe('ok');
		expect(await save('hr', 'dan', '2026-04-08', 'work')).toBe('ok');
		await ownerPool().sql`update employees set status = 'exited', exit_date = '2026-04-07' where id = ${ids.dan}`;
		expect(await code(publish('hr', '2026-04-05'))).toBe('not_employed');
	});

	it('flags unavailable time on the morning after a night shift', async () => {
		expect(
			await code(
				early(() => addAvailability(who.ana, { when: 'weekday', weekday: '2', fromTime: '02:00', toTime: '04:00' }))
			)
		).toBe('ok');
		expect(await save('hr', 'ana', '2026-04-13', 'work', 'Night')).toBe('ok');
		expect((await cell('hr', 'ana', '2026-04-13'))?.conflicts).toEqual(['Marked unavailable']);
		expect(await save('hr', 'ana', '2026-04-14', 'work')).toBe('ok');
		expect((await cell('hr', 'ana', '2026-04-14'))?.conflicts).toEqual([]);
	});

	it('rejects control characters in notes and dates far out of range', async () => {
		expect(
			await code(
				early(() => saveEntry(who.hr, { employeeId: ids.ana, date: '2026-04-15', kind: 'off', note: 'a\u0000b' }))
			)
		).toBe('invalid');
		expect(
			await code(
				early(() =>
					addAvailability(who.ana, {
						when: 'date',
						date: '2026-04-15',
						fromTime: '01:00',
						toTime: '02:00',
						note: 'a\u0000b'
					})
				)
			)
		).toBe('invalid');
		expect(await save('hr', 'ana', '9999-12-31', 'off')).toBe('invalid');
		expect(await code(early(() => publishWeek(who.hr, '9999-12-31')))).not.toMatch(/Failed query/);
	});

	it('keeps the schedule in its own tenant', async () => {
		const rows = await db((tx) => tx.select().from(rosterEntries).orderBy(asc(rosterEntries.date)));
		expect(rows.every((r) => r.tenantId === tenant.id)).toBe(true);
		const other = await createTenant('schedule-other');
		const seen = await withTenant(systemCtx(other.id), (tx) => tx.select().from(rosterEntries));
		expect(seen).toEqual([]);
	});
});
