import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendingApprovals } from '../../src/lib/server/approvals';
import { calendarMonth, issueFeed } from '../../src/lib/server/calendar';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { leaveTypes, memberships, openShiftClaims, rosterEntries, shiftSwaps } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { requestLeave } from '../../src/lib/server/leave-requests';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { icalFeed } from '../../src/lib/server/public/ical';
import { closeQueues } from '../../src/lib/server/queue';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { publishWeek, removeEntry, saveEntry } from '../../src/lib/server/schedule';
import {
	answerSwap,
	cancelSwap,
	claimOpenShift,
	decideClaim,
	decideSwap,
	expireSwaps,
	myShiftTrades,
	openShiftsIn,
	postOpenShift,
	removeOpenShift,
	requestSwap,
	withdrawClaim
} from '../../src/lib/server/shift-swaps';
import { listShifts } from '../../src/lib/server/shifts';
import { systemCtx, withTenant, type Tx } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
let general: string;
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const db = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(systemCtx(tenant.id), fn);
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
const run = (p: () => Promise<unknown>) => code(early(p));
async function work(person: string, date: string) {
	await early(() => saveEntry(who.hr, { employeeId: ids[person], date, kind: 'work', shiftId: general, note: '' }));
	await early(() => publishWeek(who.hr, date));
	return entryOf(person, date);
}
const entryOf = async (person: string, date: string) =>
	(
		await db((tx) =>
			tx
				.select()
				.from(rosterEntries)
				.where(and(eq(rosterEntries.employeeId, ids[person]), eq(rosterEntries.date, date)))
		)
	)[0];
const ownerOf = async (entryId: string) =>
	(await db((tx) => tx.select().from(rosterEntries).where(eq(rosterEntries.id, entryId))))[0]?.employeeId;
const swapOf = async (person: string) =>
	(
		await db((tx) =>
			tx.select().from(shiftSwaps).where(eq(shiftSwaps.requesterId, ids[person])).orderBy(shiftSwaps.createdAt)
		)
	).at(-1)!;
const ask = (from: string, entryId: string, to: string, counterpartEntryId = '') =>
	run(() => requestSwap(who[from], { entryId, counterpartId: ids[to], counterpartEntryId, note: '' }));
const inbox = async (key: string) =>
	(await early(() => db((tx) => pendingApprovals(tx, who[key].access)))).map((i) => i.title);
const openOn = async (date: string) =>
	(
		await db((tx) =>
			tx
				.select()
				.from(rosterEntries)
				.where(and(eq(rosterEntries.date, date), eq(rosterEntries.kind, 'work')))
		)
	).filter((e) => e.employeeId === null);

beforeAll(async () => {
	tenant = await createTenant('swaps');
	await db((tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	const [ops] = await ownerPool().sql<{ id: string }[]>`
		insert into departments (tenant_id, name) values (${tenant.id}, 'Swap Ops') returning id`;
	ids.hr = await hire('Sw Hr');
	ids.lee = await hire('Sw Lee');
	ids.kim = await hire('Sw Kim');
	ids.ana = await hire('Sw Ana', { managerId: ids.lee, departmentId: ops.id });
	ids.ben = await hire('Sw Ben', { managerId: ids.lee, departmentId: ops.id });
	ids.cat = await hire('Sw Cat', { managerId: ids.kim, departmentId: ops.id });
	ids.dan = await hire('Sw Dan');
	await member('hr', ['hr_admin'], ids.hr);
	await member('lee', ['line_manager'], ids.lee);
	await member('kim', ['line_manager'], ids.kim);
	for (const k of ['ana', 'ben', 'cat', 'dan']) await member(k, ['employee'], ids[k]);
	general = (await db(listShifts)).find((s) => s.name === 'General')!.id;
});

afterAll(async () => {
	await closeQueues();
	await closePools();
});

describe('open shifts', () => {
	it('lets staff ask for an open shift and gives it to the approved one', async () => {
		expect(await run(() => postOpenShift(who.ana, { date: '2026-03-10', shiftId: general, note: '' }))).toBe(
			'forbidden'
		);
		expect(await run(() => postOpenShift(who.hr, { date: '2026-03-01', shiftId: general, note: '' }))).toBe('too_late');
		expect(await run(() => postOpenShift(who.lee, { date: '2026-03-10', shiftId: general, note: 'Cover' }))).toBe('ok');
		const [open] = await openOn('2026-03-10');
		expect(open).toMatchObject({ status: 'published', note: 'Cover', employeeId: null });

		expect(await run(() => claimOpenShift(who.ana, open.id))).toBe('ok');
		expect(await run(() => claimOpenShift(who.ana, open.id))).toBe('already_claimed');
		expect(await run(() => claimOpenShift(who.ben, open.id))).toBe('ok');
		await work('cat', '2026-03-10');
		expect(await run(() => claimOpenShift(who.cat, open.id))).toBe('busy');
		expect(await inbox('lee')).toEqual(
			expect.arrayContaining(['Sw Ana: open shift on 2026-03-10', 'Sw Ben: open shift on 2026-03-10'])
		);
		expect(await inbox('kim')).not.toContain('Sw Ana: open shift on 2026-03-10');

		const [anaClaim] = await db((tx) =>
			tx.select().from(openShiftClaims).where(eq(openShiftClaims.employeeId, ids.ana))
		);
		expect(await run(() => decideClaim(who.kim, anaClaim.id, 'approve'))).toBe('forbidden');
		expect(await run(() => decideClaim(who.ana, anaClaim.id, 'approve'))).toBe('forbidden');
		expect(await run(() => decideClaim(who.lee, anaClaim.id, 'approve'))).toBe('ok');
		expect(await ownerOf(open.id)).toBe(ids.ana);
		const claims = await db((tx) =>
			tx.select().from(openShiftClaims).where(eq(openShiftClaims.rosterEntryId, open.id))
		);
		expect(Object.fromEntries(claims.map((c) => [c.employeeId, c.status]))).toEqual({
			[ids.ana]: 'approved',
			[ids.ben]: 'rejected'
		});
		expect(await inbox('lee')).not.toContain('Sw Ben: open shift on 2026-03-10');
		const told = await ownerPool().sql<{ title: string }[]>`
			select n.title from notifications n join memberships m on m.id = n.membership_id
			where m.employee_id = ${ids.ben} and n.title like 'The open shift%'`;
		expect(told).toHaveLength(1);
	});

	it('lets a claim be withdrawn and re-asked, and lets only the poster or HR remove it', async () => {
		await early(() => postOpenShift(who.lee, { date: '2026-03-11', shiftId: general, note: '' }));
		const [open] = await openOn('2026-03-11');
		await early(() => claimOpenShift(who.ben, open.id));
		const mine = await early(() => db((tx) => myShiftTrades(tx, who.ben.access)));
		const claim = mine.claims.find((c) => c.entryId === open.id)!;
		expect(await run(() => withdrawClaim(who.ana, claim.id))).toBe('not_found');
		expect(await run(() => withdrawClaim(who.ben, claim.id))).toBe('ok');
		expect(await run(() => claimOpenShift(who.ben, open.id))).toBe('ok');
		const listed = await early(() =>
			db((tx) => openShiftsIn(tx, who.kim.access, who.kim.user.userId, '2026-03-08', '2026-03-14'))
		);
		expect(listed.find((o) => o.id === open.id)).toMatchObject({ claims: 1, canRemove: false });
		expect(await run(() => removeOpenShift(who.kim, open.id))).toBe('forbidden');
		expect(await run(() => removeOpenShift(who.lee, open.id))).toBe('ok');
		const gone = await ownerPool().sql<{ title: string }[]>`
			select n.title from notifications n join memberships m on m.id = n.membership_id
			where m.employee_id = ${ids.ben} and n.title like '%was withdrawn'`;
		expect(gone).toHaveLength(1);
		expect(
			await db((tx) => tx.select().from(openShiftClaims).where(eq(openShiftClaims.rosterEntryId, open.id)))
		).toEqual([]);
	});
});

describe('shift swaps', () => {
	it('needs both managers when the two people report to different ones', async () => {
		const give = await work('ana', '2026-03-15');
		const take = await work('cat', '2026-03-16');
		expect(await ask('ana', give.id, 'dan')).toBe('not_found');
		expect(await ask('ana', take.id, 'cat')).toBe('not_found');
		expect(await ask('ana', give.id, 'cat', give.id)).toBe('not_found');
		expect(await ask('ana', give.id, 'cat', take.id)).toBe('ok');
		expect(await ask('ana', give.id, 'ben')).toBe('swap_pending');
		const swap = await swapOf('ana');
		expect(await run(() => answerSwap(who.ben, swap.id, 'accept'))).toBe('not_found');
		expect(await run(() => decideSwap(who.lee, swap.id, 'approve'))).toBe('not_found');
		expect(await run(() => answerSwap(who.cat, swap.id, 'accept'))).toBe('ok');
		expect(await inbox('lee')).toContain('Sw Ana: shift swap');
		expect(await inbox('kim')).toContain('Sw Cat: shift swap');
		expect(await run(() => decideSwap(who.ana, swap.id, 'approve'))).toBe('forbidden');

		expect(await early(() => decideSwap(who.lee, swap.id, 'approve'))).toBe('accepted');
		expect(await inbox('lee')).not.toContain('Sw Ana: shift swap');
		expect(await run(() => decideSwap(who.lee, swap.id, 'approve'))).toBe('forbidden');
		expect(await ownerOf(give.id)).toBe(ids.ana);
		expect(await early(() => decideSwap(who.kim, swap.id, 'approve'))).toBe('approved');

		expect(await ownerOf(give.id)).toBe(ids.cat);
		expect(await ownerOf(take.id)).toBe(ids.ana);
		expect(await entryOf('ana', '2026-03-15')).toMatchObject({ kind: 'off', status: 'published' });
		expect(await entryOf('cat', '2026-03-16')).toMatchObject({ kind: 'off', status: 'published' });
		expect(await swapOf('ana')).toMatchObject({ status: 'approved', decidedByUserId: who.kim.user.userId });

		expect(await ask('cat', give.id, 'ana', take.id)).toBe('ok');
		const back = await swapOf('cat');
		await early(() => answerSwap(who.ana, back.id, 'accept'));
		await early(() => decideSwap(who.lee, back.id, 'approve'));
		expect(await early(() => decideSwap(who.kim, back.id, 'approve'))).toBe('approved');
		expect(await ownerOf(give.id)).toBe(ids.ana);
		expect(await ownerOf(take.id)).toBe(ids.cat);
		expect(await entryOf('ana', '2026-03-16')).toMatchObject({ kind: 'off' });
		expect(await entryOf('cat', '2026-03-15')).toMatchObject({ kind: 'off' });
	});

	it('lets one manager approve both sides at once and swaps two shifts on the same day', async () => {
		const a = await work('ana', '2026-03-17');
		const b = await work('ben', '2026-03-17');
		expect(await ask('ana', a.id, 'ben', b.id)).toBe('ok');
		const swap = await swapOf('ana');
		await early(() => answerSwap(who.ben, swap.id, 'accept'));
		expect(await early(() => decideSwap(who.lee, swap.id, 'approve'))).toBe('approved');
		expect(await ownerOf(a.id)).toBe(ids.ben);
		expect(await ownerOf(b.id)).toBe(ids.ana);
		const day = await db((tx) => tx.select().from(rosterEntries).where(eq(rosterEntries.date, '2026-03-17')));
		expect(day.filter((e) => e.kind === 'off')).toEqual([]);
	});

	it('gives a shift away and rests the giver that day', async () => {
		const a = await work('ana', '2026-03-18');
		expect(await ask('ana', a.id, 'ben')).toBe('ok');
		const swap = await swapOf('ana');
		await early(() => answerSwap(who.ben, swap.id, 'accept'));
		expect(await early(() => decideSwap(who.hr, swap.id, 'approve'))).toBe('approved');
		expect(await ownerOf(a.id)).toBe(ids.ben);
		expect(await entryOf('ana', '2026-03-18')).toMatchObject({ kind: 'off' });
	});

	it('checks the swap again when it is approved', async () => {
		const a = await work('ana', '2026-03-19');
		expect(await ask('ana', a.id, 'ben')).toBe('ok');
		const swap = await swapOf('ana');
		await early(() => answerSwap(who.ben, swap.id, 'accept'));
		const [unpaid] = await db((tx) => tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'unpaid')));
		await early(() =>
			requestLeave(
				who.ben,
				{ leaveTypeId: unpaid.id, startDate: '2026-03-19', endDate: '2026-03-19', session: 'full', reason: '' },
				[]
			)
		);
		expect(await run(() => decideSwap(who.lee, swap.id, 'approve'))).toBe('leave_conflict');
		expect(await ownerOf(a.id)).toBe(ids.ana);
		expect(await run(() => decideSwap(who.lee, swap.id, 'reject'))).toBe('ok');
		expect(await swapOf('ana')).toMatchObject({ status: 'rejected' });
	});

	it('refuses days in a closed payroll month', async () => {
		const a = await work('ana', '2026-04-20');
		expect(await ask('ana', a.id, 'ben')).toBe('ok');
		const swap = await swapOf('ana');
		await early(() => answerSwap(who.ben, swap.id, 'accept'));
		await ownerPool().sql`
			insert into payroll_runs (tenant_id, run_type, period, status, inputs_hash, output_hash, computed_by_user_id, computed_at)
			values (${tenant.id}, 'regular', '2026-04', 'approved', 'x', 'x', ${who.hr.user.userId}, now())`;
		expect(await run(() => decideSwap(who.lee, swap.id, 'approve'))).toBe('payroll_closed');
		expect(await run(() => cancelSwap(who.ben, swap.id))).toBe('not_found');
		expect(await run(() => cancelSwap(who.ana, swap.id))).toBe('ok');
	});

	it('expires swaps nobody finished before the day', async () => {
		const a = await work('ana', '2026-03-24');
		expect(await ask('ana', a.id, 'ben')).toBe('ok');
		await withTestNow('2026-03-23T12:00:00+06:00', expireSwaps);
		expect(await swapOf('ana')).toMatchObject({ status: 'asked' });
		await withTestNow('2026-03-24T08:00:00+06:00', expireSwaps);
		expect(await swapOf('ana')).toMatchObject({ status: 'expired' });
		expect(await ask('ana', a.id, 'ben')).toBe('ok');
	});

	it('keeps a manager who is part of the swap from approving it', async () => {
		const [{ department_id: dept }] = await ownerPool().sql<{ department_id: string }[]>`
			select department_id from employees where id = ${ids.ana}`;
		ids.max = await hire('Sw Max', { departmentId: dept });
		ids.eve = await hire('Sw Eve', { managerId: ids.max, departmentId: dept });
		await member('max', ['line_manager'], ids.max);
		await member('eve', ['employee'], ids.eve);
		const a = await work('eve', '2026-03-26');
		const b = await work('max', '2026-03-27');
		expect(await ask('eve', a.id, 'max', b.id)).toBe('ok');
		const swap = await swapOf('eve');
		await early(() => answerSwap(who.max, swap.id, 'accept'));
		expect(await inbox('max')).not.toContain('Sw Eve: shift swap');
		expect(await run(() => decideSwap(who.max, swap.id, 'approve'))).toBe('forbidden');
		expect(await early(() => decideSwap(who.hr, swap.id, 'approve'))).toBe('approved');
	});

	it('keeps a manager from changing or removing a shift with a swap waiting', async () => {
		const a = await work('ana', '2026-03-28');
		expect(await ask('ana', a.id, 'ben')).toBe('ok');
		expect(await run(() => removeEntry(who.hr, a.id))).toBe('swap_pending');
		expect(
			await run(() =>
				saveEntry(who.hr, { employeeId: ids.ana, date: '2026-03-28', kind: 'off', shiftId: '', note: '' })
			)
		).toBe('swap_pending');
		const waiting = await swapOf('ana');
		await early(() => cancelSwap(who.ana, waiting.id));
		expect(await run(() => removeEntry(who.hr, a.id))).toBe('ok');
	});

	it('lets someone take an open shift on their day off', async () => {
		await early(() =>
			saveEntry(who.hr, { employeeId: ids.ben, date: '2026-03-29', kind: 'off', shiftId: '', note: '' })
		);
		await early(() => publishWeek(who.hr, '2026-03-29'));
		await early(() => postOpenShift(who.hr, { date: '2026-03-29', shiftId: general, note: '' }));
		const [open] = await openOn('2026-03-29');
		expect(await run(() => claimOpenShift(who.ben, open.id))).toBe('ok');
		const [claim] = await db((tx) =>
			tx.select().from(openShiftClaims).where(eq(openShiftClaims.rosterEntryId, open.id))
		);
		expect(await run(() => decideClaim(who.lee, claim.id, 'approve'))).toBe('ok');
		expect(await entryOf('ben', '2026-03-29')).toMatchObject({ id: open.id, kind: 'work' });
	});

	it('rejects bad input without a server error', async () => {
		const a = await work('ana', '2026-03-25');
		expect(await ask('ana', 'nope', 'ben')).toBe('invalid');
		expect(await ask('ana', a.id, 'ben', 'nope')).toBe('invalid');
		expect(
			await run(() =>
				requestSwap(who.ana, { entryId: a.id, counterpartId: ids.ben, counterpartEntryId: '', note: 'a\u0000b' })
			)
		).toBe('invalid');
		expect(await run(() => decideSwap(who.lee, 'nope', 'approve'))).toBe('not_found');
		expect(await run(() => decideSwap(who.lee, a.id, 'maybe'))).toBe('invalid');
	});
});

describe('roster on the calendar', () => {
	it('shows my published shifts on the month and in the feed', async () => {
		await work('dan', '2026-03-26');
		const month = await early(() => db((tx) => calendarMonth(tx, who.dan.access, '2026-03')));
		expect(month.days.find((d) => d.date === '2026-03-26')?.shifts).toEqual([
			{ name: 'General', start: '09:00', end: '18:00' }
		]);
		const other = await early(() => db((tx) => calendarMonth(tx, who.ana.access, '2026-03')));
		expect(other.days.find((d) => d.date === '2026-03-26')?.shifts).toEqual([]);
		const token = await early(() => issueFeed(who.dan));
		const body = (await (await early(() => icalFeed(`${token}.ics`, '198.51.100.7'))).text()).replace(/\r\n[ \t]/g, '');
		expect(body).toContain('SUMMARY:Shift: General 09:00–18:00');
		expect(body).toMatch(/DTSTART:20260326T030000Z\r\nDTEND:20260326T120000Z/);
	});
});
