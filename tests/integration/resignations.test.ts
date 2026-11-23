import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendingApprovals } from '../../src/lib/server/approvals';
import { closePools } from '../../src/lib/server/db';
import { employees, memberships, notifications, resignations } from '../../src/lib/server/db/schema';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import {
	decideResignation,
	getResignation,
	noticeTerms,
	ownResignation,
	submitResignation,
	withdrawResignation
} from '../../src/lib/server/resignations';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const today = dateIn(new Date(), 'Asia/Dhaka');
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
		joinDate: addDays(today, -400),
		...extra
	});

async function member(key: string, roleKeys: string[], employeeId: string) {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	ids[`${key}Membership`] = id;
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const employee = (id: string) =>
	withTenant(sys(), async (tx) => (await tx.select().from(employees).where(eq(employees.id, id)))[0]);
const resignation = (id: string) =>
	withTenant(sys(), async (tx) => (await tx.select().from(resignations).where(eq(resignations.id, id)))[0]);
const inbox = (key: string) => withTenant(sys(), (tx) => pendingApprovals(tx, who[key].access));
const titles = (membershipId: string) =>
	withTenant(sys(), async (tx) =>
		(
			await tx
				.select({ title: notifications.title })
				.from(notifications)
				.where(eq(notifications.membershipId, membershipId))
		).map((n) => n.title)
	);
const openOf = async (key: string) =>
	(await withTenant(sys(), (tx) => ownResignation(tx, who[key].access, who[key].access.employeeId!)))!;

beforeAll(async () => {
	tenant = await createTenant('resign');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.boss = await hire('Bo Boss');
	ids.staff = await hire('Sam Staff', { managerId: ids.boss });
	ids.quick = await hire('Qu Quick', { managerId: ids.boss });
	ids.mia = await hire('Mi Mia', { managerId: ids.boss });
	ids.loner = await hire('Lo Loner');
	ids.hrEmp = await hire('Ha HR');
	ids.stranger = await hire('St Stranger');
	await member('boss', ['employee'], ids.boss);
	await member('staff', ['employee'], ids.staff);
	await member('quick', ['employee'], ids.quick);
	await member('mia', ['employee'], ids.mia);
	await member('loner', ['employee'], ids.loner);
	await member('hr', ['hr_admin'], ids.hrEmp);
	await member('stranger', ['employee'], ids.stranger);
});

afterAll(closePools);

describe('resignations', () => {
	it('lets an employee resign once for themselves and sends it to their manager', async () => {
		const terms = await withTenant(sys(), noticeTerms);
		expect(terms).toEqual({ today, noticeDays: 30, earliest: addDays(today, 30) });
		const form = { lastDay: addDays(today, 30), reason: 'New job' };
		expect(await code(submitResignation(who.stranger, ids.staff, form))).toBe('not_found');
		expect(await code(submitResignation(who.hr, ids.staff, form))).toBe('forbidden');
		expect(await code(submitResignation(who.staff, ids.staff, { ...form, lastDay: addDays(today, -1) }))).toBe(
			'before_today'
		);
		expect(await code(submitResignation(who.staff, ids.staff, { ...form, reason: ' ' }))).toBe('invalid');
		expect(await code(submitResignation(who.staff, ids.staff, form))).toBe('ok');
		expect(await code(submitResignation(who.staff, ids.staff, form))).toBe('resignation_pending');
		expect((await openOf('staff')).status).toBe('pending_manager');
		expect(await titles(ids.bossMembership)).toEqual(['Sam Staff has resigned']);
		expect(await titles(ids.hrMembership)).toEqual([]);
	});

	it('shows a manager-stage resignation to the manager only, and HR once the manager agrees', async () => {
		expect((await inbox('boss')).map((i) => i.title)).toEqual(['Sam Staff resigned']);
		expect(await inbox('hr')).toEqual([]);
		expect(await inbox('stranger')).toEqual([]);
		const { id } = await openOf('staff');
		expect(await withTenant(sys(), (tx) => getResignation(tx, who.stranger.access, id))).toBeNull();
		expect((await withTenant(sys(), (tx) => getResignation(tx, who.boss.access, id)))?.stage).toBe('manager');
		expect(await code(decideResignation(who.stranger, id, { decision: 'approve', note: '' }))).toBe('not_found');
		expect(await code(decideResignation(who.boss, id, { decision: 'approve', note: 'Sad to see you go' }))).toBe('ok');
		expect(await resignation(id)).toMatchObject({ status: 'pending_hr', managerNote: 'Sad to see you go' });
		expect(await code(decideResignation(who.boss, id, { decision: 'approve', note: '' }))).toBe('forbidden');
		expect(await inbox('boss')).toEqual([]);
		expect((await inbox('hr')).map((i) => i.title)).toEqual(['Sam Staff resigned']);
		expect(await titles(ids.hrMembership)).toEqual(['Sam Staff has resigned']);
	});

	it('puts the employee on notice when HR accepts, with the agreed last day', async () => {
		const { id } = await openOf('staff');
		const accept = (lastDay: string) => decideResignation(who.hr, id, { decision: 'approve', note: '', lastDay });
		expect(await code(accept(addDays(today, -1)))).toBe('before_submitted');
		expect(await code(accept(addDays(today, 20)))).toBe('ok');
		expect(await employee(ids.staff)).toMatchObject({
			status: 'notice',
			exitDate: addDays(today, 20),
			exitType: 'resignation',
			exitReason: 'New job'
		});
		expect(await resignation(id)).toMatchObject({ status: 'approved', approvedLastDay: addDays(today, 20) });
		expect(await code(accept(addDays(today, 20)))).toBe('already_decided');
		expect(await titles(ids.staffMembership)).toEqual([
			`Your resignation was accepted. Your last day is ${addDays(today, 20)}`
		]);
		expect(await code(submitResignation(who.staff, ids.staff, { lastDay: today, reason: 'Again' }))).toBe(
			'already_leaving'
		);
	});

	it('lets HR decide before the manager and completes a same-day exit at once', async () => {
		await submitResignation(who.quick, ids.quick, { lastDay: today, reason: 'Family' });
		const { id } = await openOf('quick');
		expect(await inbox('hr')).toEqual([]);
		await withTenant(sys(), (tx) => tx.update(employees).set({ managerId: null }).where(eq(employees.id, ids.quick)));
		expect((await inbox('hr')).map((i) => i.title)).toEqual(['Qu Quick resigned']);
		expect((await withTenant(sys(), (tx) => getResignation(tx, who.hr.access, id)))?.stage).toBe('hr');
		expect(await code(decideResignation(who.hr, id, { decision: 'approve', note: '' }))).toBe('ok');
		expect((await employee(ids.quick)).status).toBe('exited');
		expect((await resignation(id)).approvedLastDay).toBe(today);
	});

	it('goes straight to HR without a manager, never to the resigner, and can be withdrawn', async () => {
		await submitResignation(who.loner, ids.loner, { lastDay: addDays(today, 40), reason: 'Studies' });
		expect((await openOf('loner')).status).toBe('pending_hr');
		await submitResignation(who.hr, ids.hrEmp, { lastDay: addDays(today, 40), reason: 'Moving' });
		expect((await inbox('hr')).map((i) => i.title)).toEqual(['Lo Loner resigned']);
		const own = await openOf('hr');
		expect(await code(decideResignation(who.hr, own.id, { decision: 'approve', note: '' }))).toBe('not_found');

		const { id } = await openOf('loner');
		expect(await code(withdrawResignation(who.hr, id))).toBe('not_found');
		expect(await code(withdrawResignation(who.loner, id))).toBe('ok');
		expect(await code(withdrawResignation(who.loner, id))).toBe('not_found');
		expect(await code(decideResignation(who.hr, id, { decision: 'approve', note: '' }))).toBe('already_decided');
		expect((await employee(ids.loner)).status).toBe('active');
	});

	it('records a decline and tells the employee', async () => {
		await submitResignation(who.loner, ids.loner, { lastDay: addDays(today, 40), reason: 'Studies' });
		const { id } = await openOf('loner');
		expect(await code(decideResignation(who.hr, id, { decision: 'reject', note: 'Let us talk' }))).toBe('ok');
		expect(await resignation(id)).toMatchObject({ status: 'rejected', decisionNote: 'Let us talk' });
		expect(await titles(ids.lonerMembership)).toEqual(['Your resignation was declined']);
		expect(await code(withdrawResignation(who.loner, id))).toBe('not_found');
		expect((await employee(ids.loner)).status).toBe('active');

		await submitResignation(who.mia, ids.mia, { lastDay: addDays(today, 30), reason: 'Unsure' });
		const mine = await openOf('mia');
		expect(await code(decideResignation(who.boss, mine.id, { decision: 'reject', note: 'Stay a while' }))).toBe('ok');
		expect(await resignation(mine.id)).toMatchObject({ status: 'rejected', managerNote: 'Stay a while' });
		expect(await titles(ids.miaMembership)).toEqual(['Your resignation was declined by your manager']);
		expect(await titles(ids.hrMembership)).not.toContain('Mi Mia has resigned');
	});
});
