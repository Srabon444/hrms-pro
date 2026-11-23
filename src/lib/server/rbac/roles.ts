import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isRestricted, PERMISSIONS, SCOPES, type Permission, type Scope } from '../../rbac/permissions';
import { canGrant } from '../../rbac/grants';
import { membershipRoles, rolePermissions, roles } from '../db/schema';
import { AppError } from '../errors';
import { withTenant, type Tx } from '../tenancy';
import { rolesWithGrants, type Actor } from './members';

export const roleInputSchema = z.object({
	name: z.string().trim().min(1, 'Enter a role name.').max(80),
	description: z.string().trim().max(300).optional().default('')
});

const grantKey = (p: string, s: string) => `${p}:${s}`;

export function parseGrants(values: string[]): [Permission, Scope][] {
	const seen = new Set<string>();
	const out: [Permission, Scope][] = [];
	for (const v of values) {
		const [p, s] = v.split(':');
		if (!(PERMISSIONS as readonly string[]).includes(p) || !(SCOPES as readonly string[]).includes(s))
			throw new AppError('invalid_grant', 'Unknown permission or scope.');
		if (!seen.has(v)) out.push([p as Permission, s as Scope]);
		seen.add(v);
	}
	return out;
}

async function editableRole(tx: Tx, actor: Actor, roleId: string) {
	await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).for('update');
	const [role] = await rolesWithGrants(tx, [roleId]);
	if (!role) throw new AppError('role_not_found', 'That role does not exist.', 404);
	if (role.locked) throw new AppError('role_locked', `The ${role.name} role cannot be changed.`, 403);
	if (actor.access.roleKeys.includes(role.key) && !actor.access.isOwner)
		throw new AppError('own_role', 'You cannot change a role you hold.', 403);
	return role;
}

export async function createRole(actor: Actor, raw: { name: string; description?: string }): Promise<string> {
	const input = roleInputSchema.parse(raw);
	const slug = input.name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_|_$/g, '')
		.slice(0, 40);
	return withTenant(actor.ctx, async (tx) => {
		const [row] = await tx
			.insert(roles)
			.values({
				tenantId: actor.tenant.id,
				key: `custom_${slug || 'role'}_${crypto.randomUUID().slice(0, 6)}`,
				name: input.name,
				description: input.description || null
			})
			.returning({ id: roles.id });
		return row.id;
	});
}

export async function updateRole(
	actor: Actor,
	roleId: string,
	raw: { name: string; description?: string; grants: [Permission, Scope][] }
): Promise<void> {
	const input = roleInputSchema.parse(raw);
	await withTenant(actor.ctx, async (tx) => {
		const role = await editableRole(tx, actor, roleId);
		const current = new Set(role.grants.map(([p, s]) => grantKey(p, s)));
		const desired = new Set(raw.grants.map(([p, s]) => grantKey(p, s)));
		const added = raw.grants.filter(([p, s]) => !current.has(grantKey(p, s)));
		const removed = role.grants.filter(([p, s]) => !desired.has(grantKey(p, s)));
		const blocked = [...added, ...removed].find(([p, s]) => !canGrant(actor.access, p, s));
		if (blocked)
			throw new AppError('grant_not_allowed', `You cannot grant or remove ${blocked[0]} (${blocked[1]}).`, 403);
		if (role.key === 'employee' && raw.grants.some(([p]) => isRestricted(p)))
			throw new AppError('restricted_on_employee', 'The Employee role cannot hold restricted permissions.', 409);
		await tx
			.update(roles)
			.set({ name: input.name, description: input.description || null })
			.where(eq(roles.id, roleId));
		if (removed.length)
			await tx.delete(rolePermissions).where(
				and(
					eq(rolePermissions.roleId, roleId),
					inArray(
						sql`${rolePermissions.permission} || ':' || ${rolePermissions.scope}`,
						removed.map(([p, s]) => grantKey(p, s))
					)
				)
			);
		if (added.length)
			await tx
				.insert(rolePermissions)
				.values(added.map(([permission, scope]) => ({ tenantId: actor.tenant.id, roleId, permission, scope })));
	});
}

export async function deleteRole(actor: Actor, roleId: string): Promise<void> {
	await withTenant(actor.ctx, async (tx) => {
		const role = await editableRole(tx, actor, roleId);
		if (role.isSystem) throw new AppError('system_role', 'Built-in roles cannot be deleted.', 409);
		const blocked = role.grants.find(([p, s]) => !canGrant(actor.access, p, s));
		if (blocked) throw new AppError('grant_not_allowed', 'You cannot delete a role with permissions you lack.', 403);
		const [used] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(membershipRoles)
			.where(eq(membershipRoles.roleId, roleId));
		if (used.n > 0) throw new AppError('role_in_use', 'Remove this role from every member first.', 409);
		await tx.delete(roles).where(eq(roles.id, roleId));
	});
}
