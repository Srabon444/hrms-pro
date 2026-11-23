import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { SYSTEM_ROLES } from '../../rbac/permissions';
import { emailSchema } from '../auth/users';
import { authPool } from '../db';
import {
	membershipRoles,
	memberships,
	platformAudit,
	rolePermissions,
	roles,
	tenantSettings,
	tenants
} from '../db/schema';
import { AppError } from '../errors';
import { createInvitation, invitationMail } from '../invitations';
import { seedLeaveTypes } from '../leave-types';
import { sendMail } from '../mail';
import { seedPayComponents } from '../salaries';
import { seedShift } from '../shifts';
import { systemCtx, withTenant, type Tx } from '../tenancy';

export const tenantInputSchema = z.object({
	slug: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'Use 2-41 lowercase letters, digits or dashes'),
	name: z.string().trim().min(1).max(120),
	ownerEmail: emailSchema
});

export async function seedTenant(tx: Tx, tenantId: string): Promise<Record<string, string>> {
	await tx.insert(tenantSettings).values({ tenantId }).onConflictDoNothing({ target: tenantSettings.tenantId });
	await seedLeaveTypes(tx, tenantId);
	await seedShift(tx, tenantId);
	await seedPayComponents(tx, tenantId);
	const created = await tx
		.insert(roles)
		.values(
			SYSTEM_ROLES.map((r) => ({
				tenantId,
				key: r.key,
				name: r.name,
				description: r.description,
				isSystem: true,
				locked: !!r.locked
			}))
		)
		.onConflictDoNothing({ target: [roles.tenantId, roles.key] })
		.returning({ id: roles.id, key: roles.key });
	const grants = created.flatMap((row) =>
		SYSTEM_ROLES.find((r) => r.key === row.key)!.grants.map(([permission, scope]) => ({
			tenantId,
			roleId: row.id,
			permission,
			scope
		}))
	);
	if (grants.length) await tx.insert(rolePermissions).values(grants).onConflictDoNothing();
	const all = await tx
		.select({ id: roles.id, key: roles.key })
		.from(roles)
		.where(
			inArray(
				roles.key,
				SYSTEM_ROLES.map((r) => r.key)
			)
		);
	return Object.fromEntries(all.map((r) => [r.key, r.id]));
}

export async function addMember(tx: Tx, tenantId: string, userId: string, roleKeys: string[]): Promise<string> {
	await tx.insert(memberships).values({ tenantId, userId }).onConflictDoNothing();
	const [m] = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, userId));
	const keys = [...new Set([...roleKeys, 'employee'])];
	const found = await tx.select({ id: roles.id }).from(roles).where(inArray(roles.key, keys));
	if (found.length !== keys.length) throw new AppError('role_not_found', 'One or more roles do not exist');
	await tx
		.insert(membershipRoles)
		.values(found.map((r) => ({ tenantId, membershipId: m.id, roleId: r.id })))
		.onConflictDoNothing();
	return m.id;
}

export async function provisionTenant(
	raw: z.input<typeof tenantInputSchema>,
	actorUserId: string | null
): Promise<{ tenantId: string; slug: string; invitationToken: string }> {
	const input = tenantInputSchema.parse(raw);
	const [t] = await authPool()
		.db.insert(tenants)
		.values({ slug: input.slug, name: input.name })
		.onConflictDoNothing({ target: tenants.slug })
		.returning({ id: tenants.id });
	if (!t) throw new AppError('slug_taken', 'That organisation URL is already taken', 409);
	const invitationToken = await withTenant(systemCtx(t.id), async (tx) => {
		const roleIds = await seedTenant(tx, t.id);
		return createInvitation(tx, { tenantId: t.id, email: input.ownerEmail, roleIds: [roleIds.owner] });
	});
	await authPool()
		.db.insert(platformAudit)
		.values({
			actorUserId,
			action: 'tenant.create',
			target: t.id,
			meta: { slug: input.slug, ownerEmail: input.ownerEmail }
		});
	await sendMail(invitationMail(input.ownerEmail, input.name, invitationToken));
	return { tenantId: t.id, slug: input.slug, invitationToken };
}

export async function setTenantStatus(tenantId: string, status: 'active' | 'suspended', actorUserId: string) {
	const [row] = await authPool()
		.db.update(tenants)
		.set({ status })
		.where(eq(tenants.id, tenantId))
		.returning({ id: tenants.id });
	if (!row) throw new AppError('tenant_not_found', 'Organisation not found', 404);
	await authPool()
		.db.insert(platformAudit)
		.values({ actorUserId, action: `tenant.${status}`, target: tenantId });
}
