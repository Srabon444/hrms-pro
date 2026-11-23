import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GrantMap } from '../../src/lib/rbac/grants';
import { closePools } from '../../src/lib/server/db';
import { employeeHistory, employees } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { decideProbation, probationDue } from '../../src/lib/server/lifecycle';
import { seedTenant } from '../../src/lib/server/platform/tenants';
import type { Access, requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
let userId: string;
const ids: Record<string, string> = {};
const today = dateIn(new Date(), 'Asia/Dhaka');

const access = (employeeId: string | null, grants: GrantMap): Access => ({
	membershipId: crypto.randomUUID(),
	employeeId,
	grants,
	roleKeys: [],
	isOwner: false
});
const hr = access(null, { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] });
const as = (a: Access) =>
	({ user: { userId }, tenant: { id: tenant.id, slug: tenant.slug, name: 'T' }, access: a }) as unknown as Member;
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const person = (fullName: string, extra: Record<string, string>) => ({
	...blanks,
	fullName,
	employmentType: 'full_time',
	status: 'probation',
	joinDate: addDays(today, -120),
	...extra
});
const row = (id: string) =>
	withTenant(systemCtx(tenant.id), async (tx) => (await tx.select().from(employees).where(eq(employees.id, id)))[0]);

beforeAll(async () => {
	tenant = await createTenant('life');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
	userId = (await createUser()).id;
	const ctx = { tenantId: tenant.id, actor: 'user' as const };
	ids.boss = await createEmployee(ctx, hr, person('Boss', { status: 'active' }));
	ids.soon = await createEmployee(
		ctx,
		hr,
		person('Soon', { probationEndDate: addDays(today, 10), managerId: ids.boss })
	);
	ids.late = await createEmployee(
		ctx,
		hr,
		person('Late', { probationEndDate: addDays(today, -3), managerId: ids.boss })
	);
	ids.far = await createEmployee(ctx, hr, person('Far', { probationEndDate: addDays(today, 60), managerId: ids.boss }));
	ids.done = await createEmployee(ctx, hr, person('Done', { status: 'active', probationEndDate: addDays(today, 5) }));
	ids.elsewhere = await createEmployee(ctx, hr, person('Elsewhere', { probationEndDate: addDays(today, 1) }));
});

afterAll(closePools);

describe('probation', () => {
	it('lists probation ending soon within the update scope, overdue first', async () => {
		const all = await withTenant(systemCtx(tenant.id), (tx) => probationDue(tx, hr));
		expect(all.rows.map((r) => [r.fullName, r.overdue])).toEqual([
			['Late', true],
			['Elsewhere', false],
			['Soon', false]
		]);
		const manager = access(ids.boss, { 'employee.read': ['team'], 'employee.update': ['team'] });
		const mine = await withTenant(systemCtx(tenant.id), (tx) => probationDue(tx, manager));
		expect(mine.rows.map((r) => r.fullName)).toEqual(['Late', 'Soon']);
	});

	it('confirms employment and records it in history', async () => {
		expect(await code(decideProbation(as(hr), ids.soon, { decision: 'confirm', date: today }))).toBe('ok');
		expect(await row(ids.soon)).toMatchObject({ status: 'active', confirmationDate: today });
		const history = await withTenant(systemCtx(tenant.id), (tx) =>
			tx.select().from(employeeHistory).where(eq(employeeHistory.employeeId, ids.soon))
		);
		expect(history.map((h) => [h.field, h.oldValue, h.newValue, h.changedByUserId])).toEqual([
			['status', 'probation', 'active', userId]
		]);
		expect(await code(decideProbation(as(hr), ids.soon, { decision: 'confirm', date: today }))).toBe(
			'not_on_probation'
		);
		expect(await code(decideProbation(as(hr), ids.done, { decision: 'extend', date: today }))).toBe('not_on_probation');
	});

	it('extends only to a later date on or after joining', async () => {
		const earlier = addDays(today, -10);
		expect(await code(decideProbation(as(hr), ids.late, { decision: 'extend', date: earlier }))).toBe('not_later');
		expect(await code(decideProbation(as(hr), ids.late, { decision: 'confirm', date: addDays(today, -500) }))).toBe(
			'before_join'
		);
		expect(await code(decideProbation(as(hr), ids.late, { decision: 'extend', date: 'later' }))).toBe('invalid');
		expect(await code(decideProbation(as(hr), ids.late, { decision: 'extend', date: addDays(today, 45) }))).toBe('ok');
		expect((await row(ids.late)).probationEndDate).toBe(addDays(today, 45));
		expect((await row(ids.late)).status).toBe('probation');
	});

	it('refuses people outside the scope', async () => {
		const manager = access(ids.boss, { 'employee.read': ['team'], 'employee.update': ['team'] });
		expect(await code(decideProbation(as(manager), ids.elsewhere, { decision: 'confirm', date: today }))).toBe(
			'not_found'
		);
		const reader = access(ids.boss, { 'employee.read': ['all'], 'employee.update': ['team'] });
		expect(await code(decideProbation(as(reader), ids.elsewhere, { decision: 'confirm', date: today }))).toBe(
			'forbidden'
		);
		expect((await row(ids.elsewhere)).status).toBe('probation');
	});
});
