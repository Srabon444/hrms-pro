import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '../../src/lib/rbac/permissions';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { roles } from '../../src/lib/server/db/schema';
import { AppError } from '../../src/lib/server/errors';
import { createInvitation } from '../../src/lib/server/invitations';
import { processors } from '../../src/lib/server/jobs';
import { provisionTenant, seedTenant } from '../../src/lib/server/platform/tenants';
import { closeQueues, startWorker } from '../../src/lib/server/queue';
import { closeRedis } from '../../src/lib/server/redis';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { mailLink, waitForMail } from '../mailpit';

const worker = startWorker('mail', processors.mail);

afterAll(async () => {
	await worker.close();
	await Promise.all([closeQueues(), closePools(), closeRedis()]);
});

const slug = () => `p-${randomUUID().slice(0, 8)}`;

describe('tenant provisioning', () => {
	it('seeds settings, every system role with its grants and mails the owner invitation', async () => {
		const ownerEmail = `${randomUUID()}@test.local`;
		const t = await provisionTenant({ slug: slug(), name: 'Probe Ltd', ownerEmail }, null);
		const counts = await ownerPool().sql<{ key: string; grants: number }[]>`
			select r.key, count(rp.id)::int as grants from roles r
			left join role_permissions rp on rp.role_id = r.id
			where r.tenant_id = ${t.tenantId} group by r.key`;
		const expected = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.key, r.grants.length]));
		expect(Object.fromEntries(counts.map((c) => [c.key, c.grants]))).toEqual(expected);
		const [settings] = await ownerPool()
			.sql`select count(*)::int as n from tenant_settings where tenant_id = ${t.tenantId}`;
		expect(settings.n).toBe(1);
		const [inv] = await ownerPool().sql`
			select i.email, i.role_ids, r.key from invitations i join roles r on r.id = any(i.role_ids)
			where i.tenant_id = ${t.tenantId}`;
		expect([inv.email, inv.key]).toEqual([ownerEmail, 'owner']);
		const mail = await waitForMail(ownerEmail);
		expect(mailLink(mail.text)).toContain(`/invite/${t.invitationToken}`);
	});

	it('refuses a taken slug and an invalid one', async () => {
		const s = slug();
		await provisionTenant({ slug: s, name: 'One', ownerEmail: `${randomUUID()}@test.local` }, null);
		await expect(provisionTenant({ slug: s, name: 'Two', ownerEmail: 'x@test.local' }, null)).rejects.toMatchObject({
			code: 'slug_taken'
		});
		await expect(provisionTenant({ slug: 'Bad Slug!', name: 'x', ownerEmail: 'x@test.local' }, null)).rejects.toThrow();
	});

	it('re-seeding is idempotent and keeps tenant edits', async () => {
		const t = await provisionTenant({ slug: slug(), name: 'Idem', ownerEmail: `${randomUUID()}@test.local` }, null);
		await withTenant(systemCtx(t.tenantId), (tx) =>
			tx.execute(sql`delete from role_permissions where role_id = (select id from roles where key = 'recruiter')`)
		);
		await withTenant(systemCtx(t.tenantId), (tx) => seedTenant(tx, t.tenantId));
		const [row] = await ownerPool().sql`
			select count(*)::int as roles, (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
				where r.tenant_id = ${t.tenantId} and r.key = 'recruiter') as recruiter
			from roles where tenant_id = ${t.tenantId}`;
		expect(row).toEqual({ roles: SYSTEM_ROLES.length, recruiter: 0 });
	});
});

describe('invitations', () => {
	it('rejects a role id from another tenant and revokes the previous pending invite', async () => {
		const a = await provisionTenant({ slug: slug(), name: 'A', ownerEmail: `${randomUUID()}@test.local` }, null);
		const b = await provisionTenant({ slug: slug(), name: 'B', ownerEmail: `${randomUUID()}@test.local` }, null);
		const [foreign] = await withTenant(systemCtx(b.tenantId), (tx) => tx.select({ id: roles.id }).from(roles).limit(1));
		const email = `${randomUUID()}@test.local`;
		await expect(
			withTenant(systemCtx(a.tenantId), (tx) =>
				createInvitation(tx, { tenantId: a.tenantId, email, roleIds: [foreign.id] })
			)
		).rejects.toBeInstanceOf(AppError);
		await withTenant(systemCtx(a.tenantId), (tx) => createInvitation(tx, { tenantId: a.tenantId, email, roleIds: [] }));
		await withTenant(systemCtx(a.tenantId), (tx) => createInvitation(tx, { tenantId: a.tenantId, email, roleIds: [] }));
		const rows = await ownerPool().sql`
			select revoked_at is not null as revoked from invitations where tenant_id = ${a.tenantId} and email = ${email}
			order by created_at`;
		expect(rows.map((r) => r.revoked)).toEqual([true, false]);
	});
});
