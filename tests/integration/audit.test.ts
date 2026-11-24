import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_PAGE_SIZE, listAudit } from '../../src/lib/server/audit';
import { closePools } from '../../src/lib/server/db';
import { createInvitation } from '../../src/lib/server/invitations';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess } from '../../src/lib/server/rbac/access';
import { createRole, updateRole } from '../../src/lib/server/rbac/roles';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

let tenant: { id: string; slug: string };

type Viewer = Parameters<typeof listAudit>[0];

async function viewer(keys: string[]): Promise<Viewer> {
	const u = await createUser();
	const id = await withTenant(systemCtx(tenant.id), (tx) => addMember(tx, tenant.id, u.id, keys));
	return {
		user: { userId: u.id, sessionId: 's', email: u.email, name: u.email, isPlatformAdmin: false, totpEnabled: true },
		tenant: { id: tenant.id, slug: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId: null })
	} as Viewer;
}

const toActor = (v: Viewer) => ({
	ctx: { tenantId: tenant.id, userId: v.user.userId, actor: 'user' as const },
	tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
	access: v.access
});

beforeAll(async () => {
	tenant = await createTenant('audit');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
});

afterAll(closePools);

describe('audit viewer', () => {
	it('masks secret columns unless the viewer holds audit.sensitive', async () => {
		await withTenant(systemCtx(tenant.id), (tx) =>
			createInvitation(tx, { tenantId: tenant.id, email: 'masked@audit.test', roleIds: [] })
		);
		const change = (entries: Awaited<ReturnType<typeof listAudit>>['entries']) =>
			entries.find((e) => e.table === 'invitations')!.changes.find((c) => c.column === 'token_hash')!;

		const hr = await listAudit(await viewer(['hr_admin']), { table: 'invitations' });
		expect(change(hr.entries).after).toBe('"***"');
		const owner = await listAudit(await viewer(['owner']), { table: 'invitations' });
		expect(change(owner.entries).after).toMatch(/^"[0-9a-f]{64}"$/);
	});

	it('names the member who made the change', async () => {
		const owner = await viewer(['owner']);
		await createRole(toActor(owner), { name: 'Named change' });
		const { entries } = await listAudit(owner, { table: 'roles' });
		const created = entries.find((e) => e.changes.some((c) => c.after === '"Named change"'));
		expect(created?.actor).toBe(owner.user.email);
	});

	it('pages through older entries without gaps or repeats', async () => {
		const owner = await viewer(['owner']);
		const actor = toActor(owner);
		const id = await createRole(actor, { name: 'Pager' });
		for (let i = 0; i < AUDIT_PAGE_SIZE + 5; i++) await updateRole(actor, id, { name: `Pager ${i}`, grants: [] });
		const first = await listAudit(owner, { table: 'roles' });
		expect(first.entries).toHaveLength(AUDIT_PAGE_SIZE);
		expect(first.next).toBe(first.entries[AUDIT_PAGE_SIZE - 1].id);
		const second = await listAudit(owner, { table: 'roles', before: first.next });
		const seen = new Set(first.entries.map((e) => e.id));
		expect(second.entries.some((e) => seen.has(e.id))).toBe(false);
		expect(first.tables).toContain('roles');
		expect(first.entries.length + second.entries.length).toBeGreaterThanOrEqual(AUDIT_PAGE_SIZE + 5);
	});

	it('ignores unknown tables and malformed cursors', async () => {
		const owner = await viewer(['owner']);
		const res = await listAudit(owner, { table: 'users; drop table x', before: 'not-a-uuid' });
		expect(res.table).toBe('');
		expect(res.entries.length).toBeGreaterThan(0);
		const other = await listAudit(owner, { before: crypto.randomUUID() });
		expect(other.entries).toEqual([]);
	});
});
