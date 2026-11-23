import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { canGrant } from '../../rbac/grants';
import { isPermission, isScopeValue, type Permission, type Scope } from '../../rbac/permissions';
import { emailSchema } from '../auth/users';
import { now } from '../clock';
import { invitations, membershipRoles, memberships, rolePermissions, roles } from '../db/schema';
import { AppError } from '../errors';
import { createInvitation, invitationMail } from '../invitations';
import { sendMail, type Mail } from '../mail';
import { notify, sendAll } from '../notifications';
import { withTenant, type TenantCtx, type Tx } from '../tenancy';
import { userCtx, type Access, type requireMember } from './access';

export type Actor = {
	ctx: TenantCtx;
	tenant: { id: string; slug: string; name: string };
	access: Access;
};

export const toActor = (m: ReturnType<typeof requireMember>): Actor => ({
	ctx: userCtx(m),
	tenant: m.tenant,
	access: m.access
});

export type RoleSummary = { id: string; key: string; name: string; locked: boolean; grants: [Permission, Scope][] };

export async function rolesWithGrants(tx: Tx, roleIds?: string[]): Promise<RoleSummary[]> {
	const rows = await tx
		.select({
			id: roles.id,
			key: roles.key,
			name: roles.name,
			locked: roles.locked,
			permission: rolePermissions.permission,
			scope: rolePermissions.scope
		})
		.from(roles)
		.leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
		.where(roleIds ? inArray(roles.id, roleIds) : undefined)
		.orderBy(roles.name);
	const byId = new Map<string, RoleSummary>();
	for (const r of rows) {
		const role = byId.get(r.id) ?? { id: r.id, key: r.key, name: r.name, locked: r.locked, grants: [] };
		byId.set(r.id, role);
		if (r.permission && isPermission(r.permission) && r.scope && isScopeValue(r.scope))
			role.grants.push([r.permission, r.scope]);
	}
	return [...byId.values()];
}

export const canHandOut = (access: Access, role: RoleSummary): boolean =>
	role.key === 'employee' || role.grants.every(([p, s]) => canGrant(access, p, s));

function assertCanHandOut(access: Access, list: RoleSummary[]) {
	const blocked = list.find((r) => !canHandOut(access, r));
	if (blocked) throw new AppError('role_not_grantable', `You cannot grant or remove the ${blocked.name} role.`, 403);
}

async function lockOwnerRole(tx: Tx): Promise<string> {
	const [owner] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, 'owner')).for('update');
	return owner.id;
}

async function otherActiveOwners(tx: Tx, ownerRoleId: string, exceptMembershipId: string): Promise<number> {
	const [row] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(membershipRoles)
		.innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
		.where(
			and(
				eq(membershipRoles.roleId, ownerRoleId),
				eq(memberships.status, 'active'),
				ne(memberships.id, exceptMembershipId)
			)
		);
	return row.n;
}

async function loadTarget(tx: Tx, actor: Actor, membershipId: string) {
	if (membershipId === actor.access.membershipId)
		throw new AppError('self_change', 'You cannot change your own access.', 403);
	const [target] = await tx
		.select({ id: memberships.id, status: memberships.status })
		.from(memberships)
		.where(eq(memberships.id, membershipId))
		.for('update');
	if (!target) throw new AppError('member_not_found', 'That member does not exist.', 404);
	const current = await tx
		.select({ roleId: membershipRoles.roleId })
		.from(membershipRoles)
		.where(eq(membershipRoles.membershipId, membershipId));
	return { ...target, roleIds: current.map((r) => r.roleId) };
}

const revokeInvitesBy = (tx: Tx, membershipId: string) =>
	tx
		.update(invitations)
		.set({ revokedAt: now() })
		.where(
			and(
				eq(invitations.invitedByMembershipId, membershipId),
				isNull(invitations.acceptedAt),
				isNull(invitations.revokedAt)
			)
		);

export async function inviteMember(actor: Actor, input: { email: string; roleIds: string[] }): Promise<void> {
	const email = emailSchema.parse(input.email);
	const roleIds = [...new Set(input.roleIds)];
	const token = await withTenant(actor.ctx, async (tx) => {
		const wanted = await rolesWithGrants(tx, roleIds);
		if (wanted.length !== roleIds.length) throw new AppError('role_not_found', 'One or more roles do not exist.');
		assertCanHandOut(actor.access, wanted);
		const existing = await tx.execute<{ id: string }>(
			sql`select membership_id as id from tenant_users where email = ${email} and membership_status = 'active'`
		);
		if (existing.length) throw new AppError('already_member', 'That person is already a member.', 409);
		return createInvitation(tx, {
			tenantId: actor.tenant.id,
			email,
			roleIds,
			invitedByMembershipId: actor.access.membershipId
		});
	});
	await sendMail(invitationMail(email, actor.tenant.name, token));
}

export async function revokeInvitation(actor: Actor, invitationId: string): Promise<void> {
	await withTenant(actor.ctx, async (tx) => {
		const [inv] = await tx
			.select({ roleIds: invitations.roleIds })
			.from(invitations)
			.where(and(eq(invitations.id, invitationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
		if (!inv) throw new AppError('invitation_not_found', 'That invitation is no longer pending.', 404);
		assertCanHandOut(actor.access, await rolesWithGrants(tx, inv.roleIds));
		await tx.update(invitations).set({ revokedAt: now() }).where(eq(invitations.id, invitationId));
	});
}

export async function setMemberRoles(actor: Actor, membershipId: string, roleIds: string[]): Promise<void> {
	const mails: Mail[] = await withTenant(actor.ctx, async (tx) => {
		const ownerRoleId = await lockOwnerRole(tx);
		const target = await loadTarget(tx, actor, membershipId);
		const [employeeRole] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, 'employee'));
		const desired = new Set([...roleIds, employeeRole.id]);
		const current = new Set(target.roleIds);
		const added = [...desired].filter((id) => !current.has(id));
		const removed = [...current].filter((id) => !desired.has(id));
		if (!added.length && !removed.length) return [];
		const touched = await rolesWithGrants(tx, [...added, ...removed]);
		if (touched.length !== added.length + removed.length)
			throw new AppError('role_not_found', 'One or more roles do not exist.');
		assertCanHandOut(actor.access, touched);
		if (removed.includes(ownerRoleId) && (await otherActiveOwners(tx, ownerRoleId, membershipId)) === 0)
			throw new AppError('last_owner', 'The organisation needs at least one active owner.', 409);
		if (removed.length) {
			await tx
				.delete(membershipRoles)
				.where(and(eq(membershipRoles.membershipId, membershipId), inArray(membershipRoles.roleId, removed)));
			await revokeInvitesBy(tx, membershipId);
		}
		if (added.length)
			await tx
				.insert(membershipRoles)
				.values(added.map((roleId) => ({ tenantId: actor.tenant.id, membershipId, roleId })));
		return notify(
			tx,
			actor.tenant.id,
			[membershipId],
			{ category: 'access', title: `Your roles in ${actor.tenant.name} changed`, link: '' },
			actor.tenant.slug
		);
	});
	await sendAll(mails);
}

export async function setMemberStatus(
	actor: Actor,
	membershipId: string,
	status: 'active' | 'disabled'
): Promise<void> {
	await withTenant(actor.ctx, async (tx) => {
		const ownerRoleId = await lockOwnerRole(tx);
		const target = await loadTarget(tx, actor, membershipId);
		if (target.status === 'ex_employee')
			throw new AppError('ex_employee', 'Former employees are managed through the exit process.', 409);
		if (target.status === status) return;
		assertCanHandOut(actor.access, await rolesWithGrants(tx, target.roleIds));
		if (
			status === 'disabled' &&
			target.roleIds.includes(ownerRoleId) &&
			(await otherActiveOwners(tx, ownerRoleId, membershipId)) === 0
		)
			throw new AppError('last_owner', 'The organisation needs at least one active owner.', 409);
		await tx.update(memberships).set({ status }).where(eq(memberships.id, membershipId));
		if (status === 'disabled') await revokeInvitesBy(tx, membershipId);
	});
}
