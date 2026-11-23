import { inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Permission } from '../../rbac/permissions';
import type { Tx } from '../tenancy';
import { scopesOf, type Access } from './access';

export type ScopeSet = { kind: 'all' } | { kind: 'ids'; ids: string[] };

const MAX_DEPTH = 20;

const teamOf = (tx: Tx, me: string) =>
	tx.execute<{ id: string }>(sql`
		with recursive team(id, depth, path) as (
			select id, 1, array[id] from employees where manager_id = ${me}::uuid
			union all
			select e.id, t.depth + 1, t.path || e.id
			from employees e join team t on e.manager_id = t.id
			where t.depth < ${MAX_DEPTH} and not e.id = any(t.path)
		)
		select distinct id from team`);

const departmentOf = (tx: Tx, me: string) =>
	tx.execute<{ id: string }>(sql`
		with recursive roots as (
			select department_id as id from employees where id = ${me}::uuid and department_id is not null
			union
			select id from departments where head_employee_id = ${me}::uuid
		), tree(id, depth) as (
			select id, 0 from roots
			union
			select d.id, t.depth + 1 from departments d join tree t on d.parent_id = t.id where t.depth < ${MAX_DEPTH}
		)
		select e.id from employees e where e.department_id in (select id from tree)`);

export async function resolveScope(tx: Tx, access: Access, permission: Permission): Promise<ScopeSet> {
	const scopes = scopesOf(access, permission);
	if (scopes.includes('all')) return { kind: 'all' };
	const me = access.employeeId;
	if (!me || !scopes.length) return { kind: 'ids', ids: [] };
	const ids = new Set([me]);
	if (scopes.includes('team')) for (const r of await teamOf(tx, me)) ids.add(r.id);
	if (scopes.includes('department')) for (const r of await departmentOf(tx, me)) ids.add(r.id);
	return { kind: 'ids', ids: [...ids] };
}

export const inScope = (set: ScopeSet, employeeId: string | null | undefined): boolean =>
	set.kind === 'all' || (!!employeeId && set.ids.includes(employeeId));

export const scopeWhere = (set: ScopeSet, column: PgColumn): SQL =>
	set.kind === 'all' ? sql`true` : set.ids.length ? inArray(column, set.ids) : sql`false`;
