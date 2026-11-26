import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { hashPassword } from '../../src/lib/server/auth/password';
import { changePassword, disableTotp } from '../../src/lib/server/auth/service';
import { calendarEntries, calendarMonth, feedStatus, issueFeed, revokeFeed } from '../../src/lib/server/calendar';
import { withTestNow } from '../../src/lib/server/clock';
import { appPool, authPool, closePools, ownerPool } from '../../src/lib/server/db';
import { eventRsvps, notifications } from '../../src/lib/server/db/schema';
import {
	deleteEvent,
	eventsBetween,
	eventsPage,
	remindEvents,
	rsvpEvent,
	saveEvent
} from '../../src/lib/server/events';
import { MODULE_IDS, MODULES, type ModuleId } from '../../src/lib/modules';
import { saveModules } from '../../src/lib/server/modules';
import { ICAL_FAILURES_PER_IP_HOUR, ICAL_PER_TOKEN_HOUR, icalFeed } from '../../src/lib/server/public/ical';
import { loadAccess, userCtx } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant, type Tx } from '../../src/lib/server/tenancy';
import { expectScoped, hire, leakWorld, type LeakWorld, type Member } from './leak';
import { expectHolderGated } from './public';

let w: LeakWorld;
let manager: Member;
let gone: string;
const DAY = '2026-12-03';
const HALF = '2026-12-04';
const sql = () => ownerPool().sql;
const at = <T>(fn: () => Promise<T>) => withTestNow(w.now, fn);
const as = <T>(m: Member, fn: (tx: Tx) => Promise<T>) => at(() => withTenant(userCtx(m), fn));
const feed = (token: string, ip = '198.51.100.1') => at(() => icalFeed(`${token}.ics`, ip));
const text = async (r: Response) => (await r.text()).replace(/\r\n[ \t]/g, '');
const freshIp = () => `2001:db8::${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}`;
const randomToken = () => randomUUID().replaceAll('-', '').padEnd(43, 'x');

async function leave(tenantId: string, employeeId: string, date: string, session = 'full') {
	const [type] = await sql()<{ id: string }[]>`
		select id from leave_types where tenant_id = ${tenantId} and code = 'casual'`;
	const [req] = await sql()<{ id: string }[]>`
		insert into leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, session, days, status, requested_by_user_id)
		values (${tenantId}, ${employeeId}, ${type.id}, ${date}, ${date}, ${session}, ${session === 'full' ? 1 : 0.5}, 'approved', ${w.viewers.all.user.userId})
		returning id`;
	await sql()`insert into leave_request_days (tenant_id, request_id, employee_id, date, session, fiscal_year, status)
		values (${tenantId}, ${req.id}, ${employeeId}, ${date}, ${session}, 2027, 'approved')`;
}

const defaults = MODULE_IDS.filter((id) => MODULES[id].on);
const without = (m: ModuleId) =>
	saveModules(
		systemCtx(w.a.id),
		defaults.filter((id) => id !== m)
	);
const restore = () => saveModules(systemCtx(w.a.id), defaults);
const holderOf = (m: Member) => ({ tenantId: m.tenant.id, membershipId: m.access.membershipId, userId: m.user.userId });

beforeAll(async () => {
	w = await leakWorld(['employee.read', 'leave.read', 'calendar.read']);
	gone = await hire(w.a.id, 'Leak Gone');
	await sql()`update employees set status = 'exited', exit_date = '2026-06-01' where id = ${gone}`;
	for (const id of [w.emp.boss, w.emp.ana, w.emp.dee, w.emp.bob, gone]) await leave(w.a.id, id, DAY);
	await leave(w.b.id, w.emp.other, DAY);
	await leave(w.a.id, w.emp.bob, HALF, 'pm');
	await sql()`insert into holidays (tenant_id, date, name) values (${w.a.id}, '2026-12-16', 'Leak Day, observed')`;
	const all = w.viewers.all;
	const [role] = await sql()<{ id: string }[]>`select id from roles where tenant_id = ${w.a.id} and key = 'leak_all'`;
	await sql()`insert into role_permissions (tenant_id, role_id, permission, scope) values (${w.a.id}, ${role.id}, 'event.manage', 'all')`;
	manager = {
		...all,
		access: await loadAccess(w.a.id, { id: all.access.membershipId, status: 'active', employeeId: null })
	} as Member;
});

afterAll(closePools);

describe('calendar entries', () => {
	it('show each viewer only people in their employee scope or own department, never exited staff', () =>
		expectScoped(
			w,
			async (m) => (await as(m, (tx) => calendarEntries(tx, m.access, DAY, DAY))).rows.map((r) => r.employeeId),
			[...Object.values(w.emp), gone]
		));

	it('name the leave type only where the viewer may read leave', async () => {
		const seen = async (m: Member, opts = {}) =>
			(await as(m, (tx) => calendarEntries(tx, m.access, DAY, DAY, opts))).rows
				.map((r) => `${r.name}/${r.type}`)
				.sort();
		expect(await seen(w.viewers.team)).toEqual(['Leak Ana/Casual leave', 'Leak Boss/Casual leave']);
		expect(await seen(w.viewers.team, { otherLeaveAsOut: true })).toEqual(['Leak Ana/Out', 'Leak Boss/Casual leave']);
		expect(await seen(w.viewers.own)).toEqual(['Leak Ana/Casual leave']);
	});

	it('cap the rows and say so', async () => {
		const r = await as(w.viewers.all, (tx) => calendarEntries(tx, w.viewers.all.access, DAY, HALF, { cap: 2 }));
		expect(r.rows).toHaveLength(2);
		expect(r.truncated).toBe(true);
	});

	it('fill a month grid of whole weeks with leave, holidays and events', async () => {
		const cal = await as(w.viewers.department, (tx) => calendarMonth(tx, w.viewers.department.access, '2026-12'));
		expect(cal.days.length % 7).toBe(0);
		expect(cal.days[0].date <= '2026-12-01').toBe(true);
		expect(cal.days.at(-1)!.date >= '2026-12-31').toBe(true);
		expect(cal.prev).toBe('2026-11');
		expect(cal.next).toBe('2027-01');
		const day = cal.days.find((d) => d.date === DAY)!;
		expect(day.out.map((o) => o.name).sort()).toEqual(['Leak Bob', 'Leak Dee']);
		expect(cal.days.find((d) => d.date === '2026-12-16')!.holidays).toEqual(['Leak Day, observed']);
		const fallback = await as(w.viewers.department, (tx) => calendarMonth(tx, w.viewers.department.access, '2026-13'));
		expect(fallback.month).toBe('2026-11');
		const far = await as(w.viewers.department, (tx) => calendarMonth(tx, w.viewers.department.access, '9999-12'));
		expect(far.month).toBe('2026-11');
	});
});

describe('public token lookup', () => {
	it('returns only the tenant and row id to the auth role, and nothing to the app role', async () => {
		const token = await at(() => issueFeed(w.viewers.own));
		const rows = await authPool().sql`select * from public.public_token_lookup('calendar_feed', ${sha256(token)})`;
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]).sort()).toEqual(['id', 'tenant_id']);
		expect(rows[0].tenant_id).toBe(w.a.id);
		expect(await authPool().sql`select * from public.public_token_lookup('calendar_feed', ${sha256('nope')})`).toEqual(
			[]
		);
		await expect(authPool().sql`select * from public.public_token_lookup('other', 'x')`).rejects.toThrow(
			/unknown_token_kind/
		);
		await expect(appPool().sql`select * from public.public_token_lookup('calendar_feed', 'x')`).rejects.toThrow(
			/permission denied/
		);
		await at(() => revokeFeed(w.viewers.own));
		expect(await authPool().sql`select * from public.public_token_lookup('calendar_feed', ${sha256(token)})`).toEqual(
			[]
		);
	});
});

describe('calendar feed', () => {
	it('serves a private calendar with others shown only as out', async () => {
		const token = await at(() => issueFeed(w.viewers.department));
		const res = await feed(token);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
		expect(res.headers.get('cache-control')).toBe('private, max-age=900');
		expect(res.headers.get('referrer-policy')).toBe('no-referrer');
		expect(res.headers.get('x-robots-tag')).toBe('noindex');
		const body = await text(res);
		expect(body).toContain('SUMMARY:Leak Dee: Casual leave');
		expect(body).toContain('SUMMARY:Leak Bob: Out');
		expect(body).not.toContain('Leak Ana');
		expect(body).not.toContain('Leak Gone');
		expect(body).toContain('SUMMARY:Holiday: Leak Day\\, observed');
		expect(body).toMatch(
			new RegExp(
				`UID:leave-${w.emp.bob}-${HALF}-pm@hrms-pro\\r\\nDTSTAMP:\\d{8}T\\d{6}Z\\r\\nDTSTART:20261204T073000Z\\r\\nDTEND:20261204T120000Z`
			)
		);
		await sql()`update shifts set end_time = '17:11' where tenant_id = ${w.a.id} and is_default`;
		try {
			const odd = await text(await feed(token, freshIp()));
			expect(odd).toMatch(
				new RegExp(`UID:leave-${w.emp.bob}-${HALF}-pm@hrms-pro\\r\\nDTSTAMP:\\S+\\r\\nDTSTART:20261204T070500Z`)
			);
		} finally {
			await sql()`update shifts set end_time = '18:00' where tenant_id = ${w.a.id} and is_default`;
		}
		const status = await as(w.viewers.department, (tx) => feedStatus(tx, w.viewers.department.access.membershipId));
		expect(status?.prefix).toBe(token.slice(0, 6));
		expect(status?.lastUsedAt).not.toBeNull();
	});

	it('answers 404 for unknown, malformed and replaced links', async () => {
		const old = await at(() => issueFeed(w.viewers.team));
		const fresh = await at(() => issueFeed(w.viewers.team));
		expect((await feed(old, freshIp())).status).toBe(404);
		expect((await feed(fresh, freshIp())).status).toBe(200);
		expect((await at(() => icalFeed('short.ics', freshIp()))).status).toBe(404);
		expect((await at(() => icalFeed(`${fresh}.txt`, freshIp()))).status).toBe(404);
		expect((await feed(randomToken(), freshIp())).status).toBe(404);
		await at(() => revokeFeed(w.viewers.team));
		expect((await feed(fresh, freshIp())).status).toBe(404);
	});

	it('keeps one live link when two are created at once', async () => {
		const tokens = await Promise.all([at(() => issueFeed(w.viewers.team)), at(() => issueFeed(w.viewers.team))]);
		const live = await Promise.all(tokens.map(async (t) => (await feed(t, freshIp())).status));
		expect(live.sort()).toEqual([200, 404]);
		await at(() => revokeFeed(w.viewers.team));
	});

	it('answers 404 once the member, the user or the organisation is switched off', async () => {
		const token = await at(() => issueFeed(w.viewers.own));
		await expectHolderGated(holderOf(w.viewers.own), () => feed(token, freshIp()));
	});

	it('answers 404 while the calendar module is off', async () => {
		const token = await at(() => issueFeed(w.viewers.own));
		await without('calendar');
		try {
			expect((await feed(token, freshIp())).status).toBe(404);
		} finally {
			await restore();
		}
		expect((await feed(token, freshIp())).status).toBe(200);
	});

	it('limits failures per address and reads per link', async () => {
		const token = await at(() => issueFeed(w.viewers.own));
		const ip = freshIp();
		for (let i = 0; i < ICAL_FAILURES_PER_IP_HOUR; i++) await feed(randomToken(), ip);
		expect((await feed(token, ip)).status).toBe(429);
		const probe = randomToken();
		for (let i = 0; i < ICAL_PER_TOKEN_HOUR; i++) expect((await feed(probe, freshIp())).status).toBe(404);
		expect((await feed(probe, freshIp())).status).toBe(429);
	});

	it('stops working after a password change or turning off two-factor sign-in', async () => {
		const m = w.viewers.own;
		await sql()`update users set password_hash = ${await hashPassword('Leak-pass-0001!')} where id = ${m.user.userId}`;
		const first = await at(() => issueFeed(m));
		await changePassword(m.user.userId, 'Leak-pass-0001!', 'Leak-pass-0002!', { ip: '127.0.0.1' });
		expect((await feed(first, freshIp())).status).toBe(404);
		const second = await at(() => issueFeed(m));
		await disableTotp(m.user.userId, 'Leak-pass-0002!');
		expect((await feed(second, freshIp())).status).toBe(404);
	});
});

describe('events', () => {
	const base = { title: 'Leak Offsite', startDate: '2026-12-10', audience: 'all' };

	it('lets only event managers create and delete, with the same rules as the form', async () => {
		await expect(at(() => saveEvent(w.viewers.own, base))).rejects.toMatchObject({ code: 'forbidden' });
		await expect(at(() => saveEvent(manager, { ...base, endDate: '2026-12-09' }))).rejects.toThrow(
			'The event cannot end before it starts.'
		);
		await expect(at(() => saveEvent(manager, { ...base, endDate: '2027-02-01' }))).rejects.toThrow('at most 32 days');
		await expect(at(() => saveEvent(manager, { ...base, startDate: '2026-11-25' }))).rejects.toMatchObject({
			code: 'past_event'
		});
		await expect(at(() => saveEvent(manager, { ...base, startTime: '10:00' }))).rejects.toThrow(
			'both a start and an end'
		);
		await expect(at(() => saveEvent(manager, { ...base, startTime: '10:00', endTime: '09:00' }))).rejects.toThrow(
			'must end after it starts'
		);
		const [foreign] = await sql()<{ id: string }[]>`
			insert into departments (tenant_id, name) values (${w.b.id}, 'Leak Foreign') returning id`;
		await expect(
			at(() => saveEvent(manager, { ...base, audience: 'department', departmentId: foreign.id }))
		).rejects.toMatchObject({ code: 'invalid_department' });
		const id = await at(() => saveEvent(manager, base));
		await expect(at(() => deleteEvent(w.viewers.own, { eventId: id }))).rejects.toMatchObject({ code: 'forbidden' });
		await at(() => deleteEvent(manager, { eventId: id }));
		await expect(at(() => deleteEvent(manager, { eventId: id }))).rejects.toMatchObject({ code: 'not_found' });
	});

	it('shows a department event and takes answers only from its audience', async () => {
		const [ops] = await sql()<{ id: string }[]>`select department_id as id from employees where id = ${w.emp.dee}`;
		const id = await at(() =>
			saveEvent(manager, {
				...base,
				title: 'Leak Ops Lunch',
				audience: 'department',
				departmentId: ops.id,
				branchId: ops.id
			})
		);
		const titles = async (m: Member) => (await as(m, (tx) => eventsPage(tx, m.access))).rows.map((r) => r.title);
		expect(await titles(w.viewers.department)).toContain('Leak Ops Lunch');
		expect(await titles(w.viewers.own)).not.toContain('Leak Ops Lunch');
		expect(await titles(manager)).toContain('Leak Ops Lunch');
		await expect(at(() => rsvpEvent(w.viewers.own, { eventId: id, response: 'yes' }))).rejects.toMatchObject({
			code: 'not_found'
		});
		await at(() => rsvpEvent(w.viewers.department, { eventId: id, response: 'yes' }));
		await at(() => rsvpEvent(w.viewers.department, { eventId: id, response: 'maybe' }));
		const answers = await withTenant(systemCtx(w.a.id), (tx) =>
			tx.select({ response: eventRsvps.response }).from(eventRsvps).where(eq(eventRsvps.eventId, id))
		);
		expect(answers).toEqual([{ response: 'maybe' }]);
		const row = (await as(w.viewers.department, (tx) => eventsPage(tx, w.viewers.department.access))).rows.find(
			(r) => r.id === id
		)!;
		expect(row.mine).toBe('maybe');
		expect(row.target).toBe('Leak Ops');
		await at(() => rsvpEvent(manager, { eventId: id, response: 'yes' }));
		await expect(at(() => rsvpEvent(w.viewers.department, { eventId: id, response: 'later' }))).rejects.toThrow(
			'Choose yes, no or maybe.'
		);
	});

	it('refuses answers to an event that is over', async () => {
		const [{ id }] = await sql()<{ id: string }[]>`
			insert into events (tenant_id, title, start_date, end_date, audience)
			values (${w.a.id}, 'Leak Past', '2026-11-20', '2026-11-20', 'all') returning id`;
		await expect(at(() => rsvpEvent(w.viewers.own, { eventId: id, response: 'yes' }))).rejects.toMatchObject({
			code: 'not_found'
		});
		const own = await as(w.viewers.own, (tx) => eventsPage(tx, w.viewers.own.access));
		expect(own.rows.map((r) => r.title)).not.toContain('Leak Past');
		const listed = (await as(manager, (tx) => eventsPage(tx, manager.access))).rows;
		expect(listed.at(-1)?.title).toBe('Leak Past');
		expect(listed[0].past).toBe(false);
	});

	it('reminds the people going the day before, once', async () => {
		const id = await at(() =>
			saveEvent(manager, {
				...base,
				title: 'Leak Standup',
				startDate: '2026-11-27',
				startTime: '09:00',
				endTime: '09:30'
			})
		);
		await at(() => rsvpEvent(w.viewers.department, { eventId: id, response: 'yes' }));
		await at(() => rsvpEvent(w.viewers.own, { eventId: id, response: 'no' }));
		const sent = () =>
			withTenant(systemCtx(w.a.id), (tx) =>
				tx
					.select({ membershipId: notifications.membershipId, title: notifications.title })
					.from(notifications)
					.where(eq(notifications.category, 'events'))
			);
		await without('events');
		await at(() => remindEvents(w.a.id, w.a.slug)).finally(restore);
		expect(await sent()).toEqual([]);
		await at(() => remindEvents(w.a.id, w.a.slug));
		expect(await sent()).toEqual([
			{ membershipId: w.viewers.department.access.membershipId, title: 'Tomorrow: Leak Standup' }
		]);
		await at(() => remindEvents(w.a.id, w.a.slug));
		expect(await sent()).toHaveLength(1);
		const feedBody = await text(await feed(await at(() => issueFeed(w.viewers.department)), freshIp()));
		expect(feedBody).toContain('SUMMARY:Leak Standup');
		expect(feedBody).toContain('DTSTART:20261127T030000Z');
	});

	it('disappear from the calendar while the events module is off', async () => {
		await without('events');
		try {
			expect(await as(manager, (tx) => eventsBetween(tx, manager.access, '2026-11-01', '2026-12-31'))).toEqual([]);
		} finally {
			await restore();
		}
		expect(
			(await as(manager, (tx) => eventsBetween(tx, manager.access, '2026-11-01', '2026-12-31'))).length
		).toBeGreaterThan(0);
	});
});
