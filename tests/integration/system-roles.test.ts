import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '../../src/lib/rbac/permissions';
import { closePools } from '../../src/lib/server/db';
import { rolePermissions, roles, systemGrants } from '../../src/lib/server/db/schema';
import { seedTenant, syncSystemRoles } from '../../src/lib/server/platform/tenants';
import { systemCtx, withTenant, type Tx } from '../../src/lib/server/tenancy';
import { createTenant, TEST_LOCALE } from './helpers';

let tenant: { id: string };
const inTenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(systemCtx(tenant.id), fn);
const sync = () => inTenant((tx) => syncSystemRoles(tx, tenant.id));
const roleId = (key: string) => inTenant(async (tx) => (await tx.select().from(roles).where(eq(roles.key, key)))[0].id);
const grantsOf = (key: string) =>
	inTenant(async (tx) =>
		(
			await tx
				.select({ permission: rolePermissions.permission, scope: rolePermissions.scope })
				.from(rolePermissions)
				.innerJoin(roles, eq(roles.id, rolePermissions.roleId))
				.where(eq(roles.key, key))
		).map((g) => `${g.permission}:${g.scope}`)
	);
const grant = async (key: string, permission: string, scope: string) => {
	const id = await roleId(key);
	await inTenant((tx) => tx.insert(rolePermissions).values({ tenantId: tenant.id, roleId: id, permission, scope }));
};
const revoke = async (key: string, permission: string) => {
	const id = await roleId(key);
	await inTenant((tx) =>
		tx.delete(rolePermissions).where(and(eq(rolePermissions.roleId, id), eq(rolePermissions.permission, permission)))
	);
};

beforeAll(async () => {
	tenant = await createTenant('sysroles');
	await inTenant((tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
});

afterAll(closePools);

describe('system role sync', () => {
	it('records every built-in grant for a new organisation and has nothing to do afterwards', async () => {
		const recorded = await inTenant((tx) => tx.select().from(systemGrants));
		expect(recorded).toHaveLength(SYSTEM_ROLES.flatMap((r) => r.grants).length);
		expect(await sync()).toEqual({ added: 0, removed: 0 });
	});

	it('brings an organisation created before the ledger up to date once', async () => {
		await inTenant((tx) => tx.delete(systemGrants));
		await revoke('hr_admin', 'workplan.edit');
		await grant('employee', 'report.weekly', 'own');
		await grant('line_manager', 'report.headcount', 'team');
		await inTenant((tx) => tx.insert(roles).values({ tenantId: tenant.id, key: 'custom', name: 'Custom' }));
		await grant('custom', 'report.weekly', 'all');
		expect(await sync()).toEqual({ added: 1, removed: 1 });
		expect(await grantsOf('hr_admin')).toContain('workplan.edit:all');
		expect(await grantsOf('employee')).not.toContain('report.weekly:own');
		expect(await grantsOf('line_manager')).toContain('report.headcount:team');
		expect(await grantsOf('custom')).toEqual(['report.weekly:all']);
		expect(await sync()).toEqual({ added: 0, removed: 0 });
	});

	it('keeps what an admin removed from or added to a built-in role', async () => {
		await revoke('line_manager', 'report.weekly');
		await grant('employee', 'report.headcount', 'own');
		expect(await sync()).toEqual({ added: 0, removed: 0 });
		expect(await grantsOf('line_manager')).not.toContain('report.weekly:team');
		expect(await grantsOf('employee')).toContain('report.headcount:own');
	});
});
