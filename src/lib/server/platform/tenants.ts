import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { RETIRED_SYSTEM_GRANTS, SYSTEM_ROLES } from '../../rbac/permissions';
import { emailSchema } from '../auth/users';
import { authPool } from '../db';
import {
	membershipRoles,
	memberships,
	platformAudit,
	rolePermissions,
	roles,
	systemGrants,
	tenantSettings,
	tenants
} from '../db/schema';
import { AppError } from '../errors';
import { createInvitation, invitationMail } from '../invitations';
import { seedLeaveTypes } from '../leave-types';
import { sendMail } from '../mail';
import { seedPayComponents } from '../salaries';
import { localeSchema, NEUTRAL_LOCALE, type Locale } from '../settings';
import { seedShift } from '../shifts';
import { seedTicketCategories } from '../helpdesk';
import { seedLetterTemplates } from '../letters';
import { systemCtx, withTenant, type Tx } from '../tenancy';

export const tenantInputSchema = z.object({
	slug: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'Use 2-41 lowercase letters, digits or dashes'),
	name: z.string().trim().min(1).max(120),
	ownerEmail: emailSchema,
	locale: localeSchema.default(NEUTRAL_LOCALE)
});

export async function seedTenant(tx: Tx, tenantId: string, locale: Locale): Promise<Record<string, string>> {
	await tx
		.insert(tenantSettings)
		.values({ tenantId, ...locale })
		.onConflictDoNothing({ target: tenantSettings.tenantId });
	await seedLeaveTypes(tx, tenantId);
	await seedShift(tx, tenantId);
	await seedTicketCategories(tx, tenantId);
	await seedLetterTemplates(tx, tenantId);
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
	await syncSystemRoles(tx, tenantId);
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
	const invite = await withTenant(systemCtx(t.id), async (tx) => {
		const roleIds = await seedTenant(tx, t.id, input.locale);
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
	await sendMail(invitationMail(input.ownerEmail, input.name, invite));
	return { tenantId: t.id, slug: input.slug, invitationToken: invite.token };
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

const grantKey = (g: { roleKey: string; permission: string; scope: string }) =>
	`${g.roleKey}|${g.permission}|${g.scope}`;

export async function syncSystemRoles(tx: Tx, tenantId: string) {
	const system = await tx.select({ id: roles.id, key: roles.key }).from(roles).where(eq(roles.isSystem, true));
	const roleIds = new Map(system.map((r) => [r.key, r.id]));
	const wanted = new Map(
		SYSTEM_ROLES.filter((r) => roleIds.has(r.key)).flatMap((r) =>
			r.grants.map(([permission, scope]) => {
				const g = { roleKey: r.key, permission, scope };
				return [grantKey(g), g] as const;
			})
		)
	);
	let seen = await tx.select().from(systemGrants);
	if (!seen.length) {
		const retired = new Set(
			RETIRED_SYSTEM_GRANTS.map(([roleKey, permission, scope]) => grantKey({ roleKey, permission, scope }))
		);
		const current = (
			await tx
				.select({ roleKey: roles.key, permission: rolePermissions.permission, scope: rolePermissions.scope })
				.from(rolePermissions)
				.innerJoin(roles, eq(roles.id, rolePermissions.roleId))
		).filter((g) => wanted.has(grantKey(g)) || retired.has(grantKey(g)));
		if (current.length)
			seen = await tx
				.insert(systemGrants)
				.values(current.map((g) => ({ tenantId, ...g })))
				.returning();
	}
	const known = new Set(seen.map(grantKey));
	const fresh = [...wanted].filter(([k]) => !known.has(k)).map(([, g]) => g);
	const dropped = seen.filter((g) => !wanted.has(grantKey(g)));
	if (fresh.length) {
		await tx
			.insert(rolePermissions)
			.values(
				fresh.map((g) => ({ tenantId, roleId: roleIds.get(g.roleKey)!, permission: g.permission, scope: g.scope }))
			)
			.onConflictDoNothing();
		await tx.insert(systemGrants).values(fresh.map((g) => ({ tenantId, ...g })));
	}
	if (dropped.length) {
		const owned = dropped.filter((g) => roleIds.has(g.roleKey));
		if (owned.length)
			await tx
				.delete(rolePermissions)
				.where(
					or(
						...owned.map((g) =>
							and(
								eq(rolePermissions.roleId, roleIds.get(g.roleKey)!),
								eq(rolePermissions.permission, g.permission),
								eq(rolePermissions.scope, g.scope)
							)
						)
					)
				);
		await tx.delete(systemGrants).where(
			inArray(
				systemGrants.id,
				dropped.map((g) => g.id)
			)
		);
	}
	return { added: fresh.length, removed: dropped.length };
}
