import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { ownerPool } from '../../src/lib/server/db';
import { memberships } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import type { Permission } from '../../src/lib/rbac/permissions';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

export type Member = ReturnType<typeof requireMember>;
export type Viewer = 'own' | 'team' | 'department' | 'all' | 'otherTenant';
type Tenant = { id: string; slug: string };
type People = 'boss' | 'ana' | 'dee' | 'bob' | 'other';

export type LeakWorld = {
	a: Tenant;
	b: Tenant;
	now: string;
	emp: Record<People, string>;
	byName: Record<string, string>;
	viewers: Record<Viewer, Member>;
	visible: Record<Viewer, string[]>;
};

const NOW = '2026-11-26T06:00:00Z';
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};

const hire = (tenantId: string, fullName: string, managerId = '') =>
	withTestNow(NOW, () =>
		createEmployee({ tenantId, actor: 'user' }, creator as never, {
			...blanks,
			fullName,
			managerId,
			employmentType: 'full_time',
			status: 'active',
			joinDate: '2026-01-01'
		})
	);

async function viewer(tenant: Tenant, permissions: Permission[], scope: string, employeeId: string | null) {
	const sql = ownerPool().sql;
	const [role] = await sql<{ id: string }[]>`
		insert into roles (tenant_id, key, name) values (${tenant.id}, ${`leak_${scope}`}, ${`Leak ${scope}`}) returning id`;
	await sql`insert into role_permissions ${sql(
		permissions.map((permission) => ({ tenant_id: tenant.id, role_id: role.id, permission, scope }))
	)}`;
	const u = await createUser();
	const id = await withTenant(systemCtx(tenant.id), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, [`leak_${scope}`]);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	return {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

export async function leakWorld(permissions: Permission[]): Promise<LeakWorld> {
	const a = await createTenant('la');
	const b = await createTenant('lb');
	await withTenant(systemCtx(a.id), (tx) => seedTenant(tx, a.id, TEST_LOCALE));
	await withTenant(systemCtx(b.id), (tx) => seedTenant(tx, b.id, TEST_LOCALE));

	const boss = await hire(a.id, 'Leak Boss');
	const ana = await hire(a.id, 'Leak Ana', boss);
	const dee = await hire(a.id, 'Leak Dee');
	const bob = await hire(a.id, 'Leak Bob', dee);
	const other = await hire(b.id, 'Leak Other');
	const sql = ownerPool().sql;
	const [ops] = await sql<{ id: string }[]>`
		insert into departments (tenant_id, name) values (${a.id}, 'Leak Ops') returning id`;
	await sql`update employees set department_id = ${ops.id} where id in (${dee}, ${bob})`;

	return {
		a,
		b,
		now: NOW,
		emp: { boss, ana, dee, bob, other },
		byName: { 'Leak Boss': boss, 'Leak Ana': ana, 'Leak Dee': dee, 'Leak Bob': bob, 'Leak Other': other },
		viewers: {
			own: await viewer(a, permissions, 'own', ana),
			team: await viewer(a, permissions, 'team', boss),
			department: await viewer(a, permissions, 'department', dee),
			all: await viewer(a, permissions, 'all', null),
			otherTenant: await viewer(b, permissions, 'all', other)
		},
		visible: {
			own: [ana],
			team: [boss, ana],
			department: [dee, bob],
			all: [boss, ana, dee, bob],
			otherTenant: [other]
		}
	};
}

export async function expectScoped(
	world: LeakWorld,
	read: (m: Member) => Promise<(string | null | undefined)[]>,
	seeded: string[] = Object.values(world.emp)
) {
	const seen = await Promise.all(
		(Object.entries(world.viewers) as [Viewer, Member][]).map(([key, m]) => read(m).then((ids) => [key, ids] as const))
	);
	for (const [key, ids] of seen)
		expect([...new Set(ids)].sort(), `${key} viewer`).toEqual(
			world.visible[key].filter((id) => seeded.includes(id)).sort()
		);
}
