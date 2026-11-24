import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { toGrantMap, type GrantMap } from '../../rbac/grants';
import type { Permission, Scope } from '../../rbac/permissions';
import { membershipRoles, rolePermissions, roles } from '../db/schema';
import { withTenant, type TenantCtx, type Tx } from '../tenancy';

export type Access = {
	membershipId: string;
	employeeId: string | null;
	grants: GrantMap;
	roleKeys: string[];
	isOwner: boolean;
};

const EX_EMPLOYEE_GRANTS: GrantMap = {
	'employee.read': ['own'],
	'document.read': ['own'],
	'payroll.read': ['own']
};

export async function readAccess(
	tx: Tx,
	membership: { id: string; status: string; employeeId: string | null }
): Promise<Access> {
	const base = { membershipId: membership.id, employeeId: membership.employeeId };
	if (membership.status === 'ex_employee') return { ...base, grants: EX_EMPLOYEE_GRANTS, roleKeys: [], isOwner: false };
	if (membership.status !== 'active') return { ...base, grants: {}, roleKeys: [], isOwner: false };
	const rows = await tx
		.select({ key: roles.key, permission: rolePermissions.permission, scope: rolePermissions.scope })
		.from(membershipRoles)
		.innerJoin(roles, eq(roles.id, membershipRoles.roleId))
		.leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
		.where(eq(membershipRoles.membershipId, membership.id));
	const roleKeys = [...new Set(rows.map((r) => r.key))];
	const grants = toGrantMap(rows.filter((r) => r.permission && r.scope) as { permission: string; scope: string }[]);
	return { ...base, grants, roleKeys, isOwner: roleKeys.includes('owner') };
}

export const loadAccess = (tenantId: string, membership: { id: string; status: string; employeeId: string | null }) =>
	withTenant({ tenantId, actor: 'system' }, (tx) => readAccess(tx, membership));

export const can = (access: Access | null, permission: Permission): boolean => !!access?.grants[permission]?.length;

export const scopesOf = (access: Access, permission: Permission): Scope[] => access.grants[permission] ?? [];

type TenantLocals = Pick<App.Locals, 'user' | 'tenant' | 'access'>;

export function requireMember(locals: TenantLocals) {
	if (!locals.user || !locals.tenant || !locals.access) error(404, 'Not found');
	return { user: locals.user, tenant: locals.tenant, access: locals.access };
}

export function requirePerm(locals: TenantLocals, permission: Permission) {
	const m = requireMember(locals);
	if (!can(m.access, permission)) error(403, 'You do not have permission to do that.');
	return m;
}

export const userCtx = (m: ReturnType<typeof requireMember>, extra: Partial<TenantCtx> = {}): TenantCtx => ({
	tenantId: m.tenant.id,
	userId: m.user.userId,
	employeeId: m.access.employeeId,
	actor: 'user',
	...extra
});
