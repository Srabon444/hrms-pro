import { error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { encrypt } from '#lib/server/auth/crypto.ts';
import { createUser } from '#lib/server/auth/users.ts';
import { config } from '#lib/server/config.ts';
import { authPool } from '#lib/server/db/index.ts';
import { employees, memberships, tenantSettings, tenants, users } from '#lib/server/db/schema/index.ts';
import { addMember, seedTenant } from '#lib/server/platform/tenants.ts';
import { systemCtx, withTenant } from '#lib/server/tenancy/index.ts';
import type { RequestHandler } from './$types';

const bodySchema = z.object({
	password: z.string().min(10),
	tenant: z.object({ name: z.string().default('E2E Org'), require2fa: z.boolean().default(false) }).optional(),
	users: z.array(
		z.object({
			key: z.string().regex(/^[a-z0-9]+$/),
			roles: z.array(z.string()).default([]),
			member: z.boolean().default(true),
			platformAdmin: z.boolean().default(false),
			employee: z.boolean().default(false),
			manager: z.string().optional(),
			totpSecret: z.string().optional()
		})
	)
});

export const POST: RequestHandler = async ({ request }) => {
	if (!config().TEST_MODE) error(404, 'Not found');
	const body = bodySchema.parse(await request.json());
	const run = randomUUID().slice(0, 8);
	let tenant: { id: string; slug: string; name: string } | null = null;
	if (body.tenant) {
		[tenant] = await authPool()
			.db.insert(tenants)
			.values({ slug: `e2e-${run}`, name: `${body.tenant.name} ${run}` })
			.returning({ id: tenants.id, slug: tenants.slug, name: tenants.name });
		const id = tenant.id;
		const require2faForSensitive = body.tenant.require2fa;
		await withTenant(systemCtx(id), async (tx) => {
			await seedTenant(tx, id);
			await tx.update(tenantSettings).set({ require2faForSensitive });
		});
	}
	const created: Record<string, { id: string; email: string; employeeId?: string }> = {};
	for (const u of body.users) {
		const email = `${u.key}-${run}@e2e.local`;
		const id = await createUser({
			email,
			name: `${u.key} ${run}`,
			password: body.password,
			isPlatformAdmin: u.platformAdmin
		});
		if (u.totpSecret)
			await authPool()
				.db.update(users)
				.set({ totpSecretEnc: encrypt(u.totpSecret), totpEnabled: true })
				.where(eq(users.id, id));
		let employeeId: string | undefined;
		if (tenant && u.member) {
			const tenantId = tenant.id;
			await withTenant(systemCtx(tenantId), async (tx) => {
				const membershipId = await addMember(tx, tenantId, id, u.roles);
				if (!u.employee) return;
				const [e] = await tx
					.insert(employees)
					.values({
						tenantId,
						code: `E2E-${u.key.toUpperCase()}`,
						fullName: `${u.key} ${run}`,
						employmentType: 'full_time',
						status: 'active',
						joinDate: '2026-01-05',
						managerId: u.manager ? created[u.manager]?.employeeId : undefined
					})
					.returning({ id: employees.id });
				employeeId = e.id;
				await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
			});
		}
		created[u.key] = { id, email, employeeId };
	}
	return Response.json({ tenant, users: created });
};
