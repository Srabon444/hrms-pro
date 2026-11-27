import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { departments, employees, membershipRoles, memberships, rolePermissions, tenantSettings } from './db/schema';
import type { Access } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import type { Tx } from './tenancy';

type Employee = typeof employees.$inferSelect;
export type ApprovalModule = 'leave' | 'attendance' | 'schedule';

export async function activeMembershipsOf(tx: Tx, employeeIds: string[]) {
	if (!employeeIds.length) return [];
	const rows = await tx
		.select({ id: memberships.id })
		.from(memberships)
		.where(and(inArray(memberships.employeeId, employeeIds), eq(memberships.status, 'active')));
	return rows.map((r) => r.id);
}

export async function activeMemberships(tx: Tx, employeeId: string | null) {
	if (!employeeId) return [];
	const rows = await tx
		.select({ id: memberships.id })
		.from(memberships)
		.where(and(eq(memberships.employeeId, employeeId), eq(memberships.status, 'active')));
	return rows.map((r) => r.id);
}

async function headOf(tx: Tx, e: Pick<Employee, 'departmentId'>) {
	if (!e.departmentId) return null;
	const [d] = await tx
		.select({ head: departments.headEmployeeId })
		.from(departments)
		.where(eq(departments.id, e.departmentId));
	return d?.head ?? null;
}

export async function approvers(tx: Tx, e: Employee, module: ApprovalModule): Promise<string[]> {
	const manager = await activeMemberships(tx, e.managerId);
	if (manager.length) return manager;
	const head = await headOf(tx, e);
	const heads = head === e.id ? [] : await activeMemberships(tx, head);
	if (heads.length) return heads;
	const rows = await tx
		.selectDistinct({ id: memberships.id })
		.from(membershipRoles)
		.innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
		.innerJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
		.where(
			and(
				inArray(rolePermissions.permission, [`${module}.approve`, `${module}.manage`]),
				eq(rolePermissions.scope, 'all'),
				eq(memberships.status, 'active'),
				or(isNull(memberships.employeeId), ne(memberships.employeeId, e.id))
			)
		);
	return rows.map((r) => r.id);
}

export const singleAdmin = async (tx: Tx) =>
	!!(await tx.select({ on: tenantSettings.allowSingleAdminApproval }).from(tenantSettings))[0]?.on;

export async function rightsOver(tx: Tx, access: Access, e: Employee, module: ApprovalModule) {
	const me = access.employeeId;
	const own = me === e.id;
	const [approve, manage, read] = await Promise.all(
		(['approve', 'manage', 'read'] as const).map((p) => resolveScope(tx, access, `${module}.${p}`))
	);
	const decider =
		inScope(approve, e.id) || inScope(manage, e.id) || (!!me && (e.managerId === me || (await headOf(tx, e)) === me));
	return {
		own,
		canDecide: decider && (!own || (await singleAdmin(tx))),
		canCancel: own || inScope(manage, e.id),
		canView: decider || inScope(read, e.id)
	};
}

export async function deciderWhere(tx: Tx, access: Access, module: ApprovalModule) {
	const [approve, manage] = await Promise.all([
		resolveScope(tx, access, `${module}.approve`),
		resolveScope(tx, access, `${module}.manage`)
	]);
	const me = access.employeeId;
	return or(
		scopeWhere(approve, employees.id),
		scopeWhere(manage, employees.id),
		me ? or(eq(employees.managerId, me), eq(departments.headEmployeeId, me)) : undefined
	);
}
