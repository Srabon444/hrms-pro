import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { memberships } from '../../src/lib/server/db/schema';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

let tenant: { id: string; slug: string };
const member = async (roleKeys: string[]) => {
	const u = await createUser();
	const id = await withTenant(systemCtx(tenant.id), (tx) => addMember(tx, tenant.id, u.id, roleKeys));
	return { id, status: 'active', employeeId: null };
};

beforeAll(async () => {
	tenant = await createTenant('rbac');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
});

afterAll(closePools);

describe('access resolution', () => {
	it('unions grants of every role and always includes the employee role', async () => {
		const access = await loadAccess(tenant.id, await member(['line_manager', 'department_head']));
		expect(access.roleKeys.sort()).toEqual(['department_head', 'employee', 'line_manager']);
		expect(access.grants['leave.approve']?.sort()).toEqual(['department', 'team']);
		expect(access.grants['employee.read']?.sort()).toEqual(['department', 'own', 'team']);
		expect(access.grants['payroll.read']).toBeUndefined();
		expect(access.isOwner).toBe(false);
	});

	it('marks owners and gives them every permission at all scope', async () => {
		const access = await loadAccess(tenant.id, await member(['owner']));
		expect(access.isOwner).toBe(true);
		expect(access.grants['audit.sensitive']).toEqual(['all']);
	});

	it('gives no grants to a membership that is not active', async () => {
		const m = await member(['hr_admin']);
		await withTenant(systemCtx(tenant.id), (tx) =>
			tx.update(memberships).set({ status: 'ex_employee' }).where(eq(memberships.id, m.id))
		);
		const access = await loadAccess(tenant.id, { ...m, status: 'ex_employee' });
		expect(access.grants).toEqual({});
	});

	it('cannot read another tenant’s membership roles', async () => {
		const m = await member(['owner']);
		const other = await createTenant('rbac-other');
		const access = await loadAccess(other.id, m);
		expect(access.roleKeys).toEqual([]);
	});
});
