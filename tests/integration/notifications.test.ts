import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { notificationPrefs, notifications } from '../../src/lib/server/db/schema';
import { notify } from '../../src/lib/server/notifications';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

let tenant: { id: string; slug: string };

beforeAll(async () => {
	tenant = await createTenant('notif');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
});

afterAll(closePools);

describe('notify', () => {
	it('stores an in-app row for every recipient and mails only those who did not opt out', async () => {
		const a = await createUser();
		const b = await createUser();
		const mails = await withTenant(systemCtx(tenant.id), async (tx) => {
			const ma = await addMember(tx, tenant.id, a.id, []);
			const mb = await addMember(tx, tenant.id, b.id, []);
			await tx
				.insert(notificationPrefs)
				.values({ tenantId: tenant.id, membershipId: mb, category: 'access', email: false });
			const out = await notify(
				tx,
				tenant.id,
				[ma, mb, ma],
				{ category: 'access', title: 'Your roles changed', link: 'settings' },
				tenant.slug
			);
			const rows = await tx.select().from(notifications).where(eq(notifications.title, 'Your roles changed'));
			expect(rows.map((r) => r.membershipId).sort()).toEqual([ma, mb].sort());
			return out;
		});
		expect(mails).toHaveLength(1);
		expect(mails[0].to).toBe(a.email);
		expect(mails[0].text).toContain(`/t/${tenant.slug}/settings`);
	});
});
