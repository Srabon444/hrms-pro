import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import { employees, memberships, workPlanItems } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { addItem, removeItem, rolloverWeek, setItemStatus, workPlan } from '../../src/lib/server/work-plans';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
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
const add = (key: string, owner: string, description: string, weekStart = WEEK) =>
	code(() => addItem(who[key], { employeeId: ids[owner], weekStart, description, target: '' }));
const plan = (key: string, week: string | null = null) =>
	at(() => withTenant(userCtx(who[key]), (tx) => workPlan(tx, who[key].access, week)));
const titles = async (key: string, week: string | null = null) =>
	(await plan(key, week)).items.map((i) => `${i.name}: ${i.description}`);

beforeAll(async () => {
	tenant = await createTenant('workplan');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.lea = await hire('Lea');
	ids.ana = await hire('Ana', ids.lea);
	ids.ben = await hire('Ben');
	ids.old = await hire('Old', ids.lea);
	await member('hr', ['hr_admin'], null);
	await member('lea', ['line_manager'], ids.lea);
	await member('ana', [], ids.ana);
	await member('ben', [], ids.ben);
});

afterAll(closePools);

describe('work plan', () => {
	it('lets people plan the current or a later week for anyone in their scope', async () => {
		expect(await add('ana', 'ana', 'Write billing spec')).toBe('ok');
		expect(await add('lea', 'ana', 'Review PRs')).toBe('ok');
		expect(await add('ben', 'ben', 'Fix wifi')).toBe('ok');
		expect(await add('ana', 'ben', 'Sneak')).toBe('invalid_owner');
		expect(await add('ana', 'ana', 'Odd day', '2026-11-23')).toBe('not_week_start');
		expect(await add('ana', 'ana', 'Too late', '2026-11-15')).toBe('past_week');
		expect(await add('ana', 'ana', 'Next week', '2026-11-29')).toBe('ok');
		expect(await add('ana', 'ana', '   ')).toBe('invalid: Describe the item.');
		expect(await add('lea', 'old', 'Old task')).toBe('ok');
		await withTenant(sys(), (tx) => tx.update(employees).set({ status: 'exited' }).where(eq(employees.id, ids.old)));
		expect(await add('lea', 'old', 'Ghost')).toBe('invalid_owner');

		expect(await titles('lea')).toEqual(['Ana: Write billing spec', 'Ana: Review PRs', 'Old: Old task']);
		expect(await titles('ana', '2026-11-26')).toEqual(['Ana: Write billing spec', 'Ana: Review PRs']);
		expect(await titles('ben', 'not-a-date')).toEqual(['Ben: Fix wifi']);
		expect(await titles('hr')).toEqual([
			'Ana: Write billing spec',
			'Ana: Review PRs',
			'Ben: Fix wifi',
			'Old: Old task'
		]);
		const lea = await plan('lea');
		expect([lea.week, lea.previous, lea.next, lea.canPlan]).toEqual([WEEK, '2026-11-15', '2026-11-29', true]);
		expect(lea.people.map((p) => p.name)).toEqual(['Ana', 'Lea']);
		expect((await plan('lea', '2026-11-15')).canPlan).toBe(false);
	});

	it('tracks status and carries unfinished items into the next week once', async () => {
		const [spec, prs] = (await plan('ana')).items;
		const status = (key: string, itemId: string, s: string) =>
			code(() => setItemStatus(who[key], { itemId, status: s }));
		expect(await status('ben', spec.id, 'done')).toBe('not_found');
		expect(await status('ana', spec.id, 'finished')).toBe('invalid: Choose pending, in progress or done.');
		expect(await status('ana', spec.id, 'done')).toBe('ok');

		const roll = (key: string, weekStart: string) => at(() => rolloverWeek(who[key], { weekStart }));
		expect(await code(() => rolloverWeek(who.ana, { weekStart: '2026-11-08' }))).toBe('past_week');
		expect(await code(() => rolloverWeek(who.ana, { weekStart: '2026-11-24' }))).toBe('not_week_start');
		expect(await roll('ana', WEEK)).toEqual({ next: '2026-11-29', count: 1 });
		expect(await roll('ana', WEEK)).toEqual({ next: '2026-11-29', count: 0 });
		expect(await titles('ana', '2026-11-29')).toEqual(['Ana: Next week', 'Ana: Review PRs']);
		expect((await plan('ana', '2026-11-29')).items[1].carried).toBe(prs.id);
		expect(await titles('ben', '2026-11-29')).toEqual([]);
		expect(await roll('hr', WEEK)).toEqual({ next: '2026-11-29', count: 1 });
		expect(await titles('ben', '2026-11-29')).toEqual(['Ben: Fix wifi']);
	});

	it('removes only items in scope', async () => {
		const [spec] = (await plan('ana')).items;
		expect(await code(() => removeItem(who.ben, { itemId: spec.id }))).toBe('not_found');
		expect(await code(() => removeItem(who.ana, { itemId: spec.id }))).toBe('ok');
		const left = await withTenant(sys(), (tx) => tx.select().from(workPlanItems).where(eq(workPlanItems.id, spec.id)));
		expect(left).toEqual([]);
	});
});
