import { and, eq } from 'drizzle-orm';
import { now } from '../clock';
import { authPool } from '../db';
import { memberships, tenants } from '../db/schema';

export type TenantAccess = {
	tenant: { id: string; slug: string; name: string };
	membership: { id: string; status: 'active' | 'ex_employee'; employeeId: string | null };
};

export async function resolveTenantAccess(slug: string, userId: string): Promise<TenantAccess | null> {
	if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return null;
	const [row] = await authPool()
		.db.select({
			id: tenants.id,
			slug: tenants.slug,
			name: tenants.name,
			tenantStatus: tenants.status,
			membershipId: memberships.id,
			status: memberships.status,
			employeeId: memberships.employeeId,
			exAccessUntil: memberships.exAccessUntil
		})
		.from(tenants)
		.innerJoin(memberships, and(eq(memberships.tenantId, tenants.id), eq(memberships.userId, userId)))
		.where(eq(tenants.slug, slug));
	if (!row || row.tenantStatus !== 'active') return null;
	const exAllowed = row.status === 'ex_employee' && !!row.exAccessUntil && row.exAccessUntil > now();
	if (row.status !== 'active' && !exAllowed) return null;
	return {
		tenant: { id: row.id, slug: row.slug, name: row.name },
		membership: { id: row.membershipId, status: row.status as 'active' | 'ex_employee', employeeId: row.employeeId }
	};
}

export async function listUserTenants(userId: string): Promise<{ slug: string; name: string }[]> {
	const rows = await authPool()
		.db.select({
			slug: tenants.slug,
			name: tenants.name,
			status: memberships.status,
			exAccessUntil: memberships.exAccessUntil
		})
		.from(memberships)
		.innerJoin(tenants, eq(tenants.id, memberships.tenantId))
		.where(and(eq(memberships.userId, userId), eq(tenants.status, 'active')))
		.orderBy(tenants.name);
	const t = now();
	return rows
		.filter((r) => r.status === 'active' || (r.status === 'ex_employee' && !!r.exAccessUntil && r.exAccessUntil > t))
		.map(({ slug, name }) => ({ slug, name }));
}
