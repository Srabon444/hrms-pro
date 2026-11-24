import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { employees, memberships } from '../../src/lib/server/db/schema';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { exitInterviewView, submitExitInterview } from '../../src/lib/server/exit-interviews';
import { recordExit, withdrawExit } from '../../src/lib/server/exits';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
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
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const view = (key: string) =>
	withTenant(sys(), async (tx) => {
		const [e] = await tx.select().from(employees).where(eq(employees.id, ids.leaver));
		return exitInterviewView(tx, who[key].access, e);
	});
const answers = { primaryReason: 'growth', rating: '4', wouldRecommend: 'on', comments: 'Great team' };

beforeAll(async () => {
	tenant = await createTenant('interview');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.boss = await hire('Bea Boss');
	ids.leaver = await hire('Leo Leaving', { managerId: ids.boss });
	ids.hrEmp = await hire('Hal HR');
	await member('boss', ['employee', 'line_manager'], ids.boss);
	await member('leaver', ['employee'], ids.leaver);
	await member('hr', ['hr_admin'], ids.hrEmp);
});

afterAll(closePools);

describe('exit interviews', () => {
	it('opens only once an exit is recorded, for the leaver and HR', async () => {
		expect(await view('leaver')).toBeNull();
		expect(await code(submitExitInterview(who.leaver, ids.leaver, answers))).toBe('not_leaving');
		await recordExit(who.hr, ids.leaver, { exitDate: addDays(today, 14), exitType: 'resignation', exitReason: '' });
		expect(await view('leaver')).toMatchObject({ submitted: false, answers: null });
		expect(await view('hr')).toMatchObject({ submitted: false, answers: null });
		expect(await view('boss')).toBeNull();
		expect(await code(submitExitInterview(who.boss, ids.leaver, answers))).toBe('forbidden');
	});

	it('takes one validated answer per exit and shows it to HR only', async () => {
		expect(await code(submitExitInterview(who.leaver, ids.leaver, { ...answers, rating: '6' }))).toBe('invalid');
		expect(await code(submitExitInterview(who.leaver, ids.leaver, { ...answers, primaryReason: 'boredom' }))).toBe(
			'invalid'
		);
		expect(await code(submitExitInterview(who.leaver, ids.leaver, answers))).toBe('ok');
		expect(await code(submitExitInterview(who.leaver, ids.leaver, answers))).toBe('already_submitted');
		expect(await code(submitExitInterview(who.hr, ids.leaver, answers))).toBe('already_submitted');
		expect(await view('leaver')).toMatchObject({ submitted: true, answers: null });
		expect((await view('hr'))?.answers).toEqual({
			primaryReason: 'growth',
			rating: 4,
			wouldRecommend: true,
			wouldRejoin: false,
			comments: 'Great team'
		});
	});

	it('starts a fresh interview when a different exit is recorded', async () => {
		await withdrawExit(who.hr, ids.leaver);
		expect(await view('hr')).toBeNull();
		await recordExit(who.hr, ids.leaver, { exitDate: addDays(today, 60), exitType: 'resignation', exitReason: '' });
		expect(await view('hr')).toMatchObject({ submitted: false });
		expect(await code(submitExitInterview(who.hr, ids.leaver, answers))).toBe('ok');
		expect(await view('leaver')).toMatchObject({ submitted: true, answers: null });
	});
});
