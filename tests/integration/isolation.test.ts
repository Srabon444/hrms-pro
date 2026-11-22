import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appPool, closePools, ownerPool } from '../../src/lib/server/db';
import { roles, memberships, auditLog, auditSensitive, files } from '../../src/lib/server/db/schema';
import { withTenant, type TenantCtx } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

let a: { id: string; slug: string };
let b: { id: string; slug: string };

const allFlags = (tenantId: string): TenantCtx => ({
	tenantId,
	actor: 'user',
	payrollAll: true,
	salaryAll: true,
	auditSensitive: true
});

beforeAll(async () => {
	a = await createTenant('iso-a');
	b = await createTenant('iso-b');
	for (const t of [a, b]) {
		await withTenant({ tenantId: t.id, actor: 'system' }, (tx) =>
			tx.insert(roles).values({ tenantId: t.id, key: 'probe', name: `probe ${t.slug}` })
		);
	}
});

afterAll(closePools);

describe('tenant isolation', () => {
	it('reads only the current tenant even with every flag on', async () => {
		const rows = await withTenant(allFlags(a.id), (tx) => tx.select().from(roles));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.tenantId === a.id)).toBe(true);
	});

	it('sees nothing without a tenant context', async () => {
		const rows = await appPool().db.select().from(roles);
		expect(rows).toEqual([]);
	});

	it('rejects inserting a row for another tenant', async () => {
		await expect(
			withTenant(allFlags(a.id), (tx) => tx.insert(roles).values({ tenantId: b.id, key: 'evil', name: 'evil' }))
		).rejects.toThrow();
	});

	it('rejects moving a row to another tenant and cannot update foreign rows', async () => {
		await expect(
			withTenant(allFlags(a.id), (tx) =>
				tx
					.update(roles)
					.set({ tenantId: b.id })
					.where(sql`key = 'probe'`)
			)
		).rejects.toThrow();
		const touched = await withTenant(allFlags(a.id), (tx) =>
			tx
				.update(roles)
				.set({ name: 'hijack' })
				.where(sql`tenant_id = ${b.id}`)
				.returning()
		);
		expect(touched).toEqual([]);
		const [bRole] = await ownerPool().sql`select name from roles where tenant_id = ${b.id} and key = 'probe'`;
		expect(bRole.name).not.toBe('hijack');
	});

	it('does not leak settings across transactions on a pooled connection', async () => {
		await withTenant(allFlags(a.id), (tx) => tx.select().from(roles));
		const [row] = await appPool().sql`select current_setting('app.tenant_id', true) as t`;
		expect(row.t ?? '').toBe('');
	});

	it('tenant_users view only shows memberships of the current tenant', async () => {
		const u = await createUser();
		for (const t of [a, b]) {
			await withTenant({ tenantId: t.id, actor: 'system' }, (tx) =>
				tx.insert(memberships).values({ tenantId: t.id, userId: u.id })
			);
		}
		const rows = await withTenant(allFlags(a.id), (tx) =>
			tx.execute<{ tenant_id: string; email: string }>(sql`select tenant_id, email from tenant_users`)
		);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.tenant_id === a.id)).toBe(true);
	});
});

describe('audit trail', () => {
	it('writes masked audit rows with the actor and hides sensitive values without the flag', async () => {
		const userId = (await createUser()).id;
		const ctx: TenantCtx = { tenantId: a.id, userId, actor: 'user' };
		const [role] = await withTenant(ctx, (tx) =>
			tx.insert(roles).values({ tenantId: a.id, key: 'audited', name: 'Audited' }).returning()
		);
		await withTenant(ctx, (tx) =>
			tx
				.update(roles)
				.set({ name: 'Audited 2' })
				.where(sql`id = ${role.id}`)
		);
		await withTenant(ctx, (tx) =>
			tx
				.update(roles)
				.set({ name: 'Audited 2' })
				.where(sql`id = ${role.id}`)
		);

		const logs = await withTenant(ctx, (tx) =>
			tx
				.select()
				.from(auditLog)
				.where(sql`row_id = ${role.id}`)
				.orderBy(auditLog.createdAt)
		);
		expect(logs.map((l) => l.op)).toEqual(['INSERT', 'UPDATE']);
		expect(logs[1].changedColumns).toEqual(['name']);
		expect(logs[1].actorUserId).toBe(userId);
		expect(logs[1].newValues).toEqual({ name: 'Audited 2' });

		const hidden = await withTenant(ctx, (tx) => tx.select().from(auditSensitive));
		expect(hidden).toEqual([]);
	});

	it('masks unlisted columns into audit_sensitive, readable only with the flag', async () => {
		const ctx: TenantCtx = { tenantId: a.id, actor: 'system' };
		const key = `t/${a.id}/probe-${Date.now()}`;
		const [f] = await withTenant(ctx, (tx) =>
			tx
				.insert(files)
				.values({
					tenantId: a.id,
					key,
					filename: 'a.pdf',
					mime: 'application/pdf',
					size: 10,
					sha256: 'abc',
					ownerType: 'probe'
				})
				.returning()
		);
		const [log] = await withTenant(ctx, (tx) =>
			tx
				.select()
				.from(auditLog)
				.where(sql`row_id = ${f.id}`)
		);
		const shown = log.newValues as Record<string, unknown>;
		expect(shown.key).toBe('***');
		expect(shown.sha256).toBe('***');
		expect(shown.filename).toBe('a.pdf');

		const withFlag = await withTenant({ ...ctx, auditSensitive: true }, (tx) =>
			tx
				.select()
				.from(auditSensitive)
				.where(sql`audit_id = ${log.id}`)
		);
		expect(withFlag).toHaveLength(1);
		expect(withFlag[0].newValues).toEqual({ key, sha256: 'abc' });
		const without = await withTenant(ctx, (tx) =>
			tx
				.select()
				.from(auditSensitive)
				.where(sql`audit_id = ${log.id}`)
		);
		expect(without).toEqual([]);
	});

	it('cannot update or delete audit rows as the app role', async () => {
		await expect(withTenant(allFlags(a.id), (tx) => tx.execute(sql`delete from audit_log`))).rejects.toThrow();
		await expect(withTenant(allFlags(a.id), (tx) => tx.execute(sql`update audit_log set op = 'X'`))).rejects.toThrow();
	});
});
