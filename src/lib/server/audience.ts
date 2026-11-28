import { sql } from 'drizzle-orm';
import type { Tx } from './tenancy';

export type Audience = { audience: string; departmentId: string | null; branchId: string | null };

export async function audienceMembers(tx: Tx, a: Audience): Promise<string[]> {
	const rows = await tx.execute<{ id: string }>(sql`
		with recursive down(id, depth) as (
			select id, 0 from departments where id = ${a.departmentId}::uuid
			union all
			select d.id, down.depth + 1 from departments d join down on d.parent_id = down.id where down.depth < 20
		)
		select tu.membership_id as id
		from tenant_users tu left join employees e on e.id = tu.employee_id
		where tu.membership_status = 'active' and tu.user_status = 'active' and (
			${a.audience} = 'all'
			or (${a.audience} = 'department' and e.department_id in (select id from down))
			or (${a.audience} = 'branch' and e.branch_id = ${a.branchId}::uuid))`);
	return rows.map((r) => r.id);
}

export const activeMember = (membershipId: string) =>
	sql`exists (select 1 from memberships am where am.id = ${membershipId}::uuid and am.status = 'active')`;

export async function memberNames(tx: Tx, ids: string[]) {
	if (!ids.length) return new Map<string, string>();
	const rows = await tx.execute<{ id: string; name: string }>(
		sql`select membership_id as id, name from tenant_users where membership_id in ${ids}`
	);
	return new Map(rows.map((r) => [r.id, r.name]));
}
