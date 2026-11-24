import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { can, loadAccess } from '../../src/lib/server/rbac/access';
import { setMemberRoles, type Actor } from '../../src/lib/server/rbac/members';
import { createRole, deleteRole, parseGrants, updateRole } from '../../src/lib/server/rbac/roles';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

let tenant: { id: string; slug: string };
let roleIds: Record<string, string>;

async function member(keys: string[], extraRoleIds: string[] = []) {
	const u = await createUser();
	const id = await withTenant(systemCtx(tenant.id), (tx) => addMember(tx, tenant.id, u.id, keys));
	const m = { id, userId: u.id };
	if (extraRoleIds.length)
		await setMemberRoles(await actorFor(await ownerMember()), id, [roleIds.employee, ...extraRoleIds]);
	return m;
}

let owner: { id: string; userId: string } | undefined;
async function ownerMember() {
	if (!owner) {
		const u = await createUser();
		owner = {
			id: await withTenant(systemCtx(tenant.id), (tx) => addMember(tx, tenant.id, u.id, ['owner'])),
			userId: u.id
		};
	}
	return owner;
}

async function actorFor(m: { id: string; userId: string }): Promise<Actor> {
	return {
		ctx: { tenantId: tenant.id, userId: m.userId, actor: 'user' },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id: m.id, status: 'active', employeeId: null })
	};
}

const code = (p: Promise<unknown>) => p.then(() => 'ok').catch((e: { code?: string }) => e.code ?? String(e));

let roleAdmin: Actor;

beforeAll(async () => {
	tenant = await createTenant('roles');
	roleIds = await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
	const own = await actorFor(await ownerMember());
	const adminRole = await createRole(own, { name: 'Role admin' });
	await updateRole(own, adminRole, {
		name: 'Role admin',
		grants: parseGrants(['role.manage:all', 'leave.read:all', 'leave.approve:team'])
	});
	roleAdmin = await actorFor(await member([], [adminRole]));
});

afterAll(closePools);

describe('role editor guards', () => {
	it('rejects unknown permissions and scopes', () => {
		expect(() => parseGrants(['leave.read:galaxy'])).toThrow();
		expect(() => parseGrants(['made.up:all'])).toThrow();
		expect(parseGrants(['leave.read:all', 'leave.read:all'])).toEqual([['leave.read', 'all']]);
	});

	it('the service rejects unknown grants and folds repeated ones itself', async () => {
		const own = await actorFor(await ownerMember());
		const role = await createRole(own, { name: 'Direct caller' });
		const raw = (g: string[]) => g.map((v) => v.split(':')) as Parameters<typeof updateRole>[2]['grants'];
		expect(await code(updateRole(own, role, { name: 'Direct caller', grants: raw(['made.up:all']) }))).toBe(
			'invalid_grant'
		);
		expect(
			await code(updateRole(own, role, { name: 'Direct caller', grants: raw(['leave.read:all', 'leave.read:all']) }))
		).toBe('ok');
	});

	it('nobody edits the owner role', async () => {
		const own = await actorFor(await ownerMember());
		expect(await code(updateRole(own, roleIds.owner, { name: 'Boss', grants: [] }))).toBe('role_locked');
	});

	it('a non-owner cannot edit a role they hold', async () => {
		const held = roleAdmin.access.roleKeys.find((k) => k.startsWith('custom_'));
		expect(held).toBeTruthy();
		const ids = await withTenant(systemCtx(tenant.id), (tx) =>
			tx.query.roles.findFirst({ where: (r, { eq }) => eq(r.key, held!) })
		);
		expect(await code(updateRole(roleAdmin, ids!.id, { name: 'More', grants: parseGrants(['role.manage:all']) }))).toBe(
			'own_role'
		);
	});

	it('a non-owner grants only what they hold, never restricted permissions', async () => {
		const id = await createRole(roleAdmin, { name: 'Leave clerk' });
		expect(
			await code(updateRole(roleAdmin, id, { name: 'Leave clerk', grants: parseGrants(['leave.read:all']) }))
		).toBe('ok');
		expect(
			await code(updateRole(roleAdmin, id, { name: 'Leave clerk', grants: parseGrants(['leave.approve:all']) }))
		).toBe('grant_not_allowed');
		expect(
			await code(updateRole(roleAdmin, id, { name: 'Leave clerk', grants: parseGrants(['role.manage:all']) }))
		).toBe('grant_not_allowed');
		expect(
			await code(updateRole(roleAdmin, id, { name: 'Leave clerk', grants: parseGrants(['leave.approve:team']) }))
		).toBe('ok');
	});

	it('a non-owner cannot strip permissions they do not hold', async () => {
		expect(await code(updateRole(roleAdmin, roleIds.finance, { name: 'Finance', grants: [] }))).toBe(
			'grant_not_allowed'
		);
	});

	it('the employee role never takes restricted permissions', async () => {
		const own = await actorFor(await ownerMember());
		expect(
			await code(updateRole(own, roleIds.employee, { name: 'Employee', grants: parseGrants(['payroll.read:all']) }))
		).toBe('restricted_on_employee');
	});

	it('built-in and in-use roles are not deleted', async () => {
		const own = await actorFor(await ownerMember());
		expect(await code(deleteRole(own, roleIds.recruiter))).toBe('system_role');
		const id = await createRole(own, { name: 'Temp' });
		const staff = await member([], [id]);
		expect(await code(deleteRole(own, id))).toBe('role_in_use');
		await setMemberRoles(own, staff.id, [roleIds.employee]);
		expect(await code(deleteRole(own, id))).toBe('ok');
	});

	it('a grant change applies to holders on their next request', async () => {
		const own = await actorFor(await ownerMember());
		const id = await createRole(own, { name: 'Reporter' });
		const staff = await member([], [id]);
		const before = await loadAccess(tenant.id, { id: staff.id, status: 'active', employeeId: null });
		expect(can(before, 'report.headcount')).toBe(false);
		await updateRole(own, id, { name: 'Reporter', grants: parseGrants(['report.headcount:all']) });
		const after = await loadAccess(tenant.id, { id: staff.id, status: 'active', employeeId: null });
		expect(can(after, 'report.headcount')).toBe(true);
	});
});
