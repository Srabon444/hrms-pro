import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { now } from '#lib/server/clock.ts';
import { z } from 'zod';
import { notificationPrefs, notifications } from '#lib/server/db/schema/index.ts';
import { field } from '#lib/server/http/forms.ts';
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '#lib/server/notifications.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

const categories = Object.keys(NOTIFICATION_CATEGORIES) as NotificationCategory[];

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	const mine = eq(notifications.membershipId, m.access.membershipId);
	return withTenant(userCtx(m), async (tx) => {
		const items = await tx
			.select({
				id: notifications.id,
				title: notifications.title,
				body: notifications.body,
				link: notifications.link,
				readAt: notifications.readAt,
				createdAt: notifications.createdAt
			})
			.from(notifications)
			.where(mine)
			.orderBy(desc(notifications.createdAt))
			.limit(100);
		const prefs = await tx
			.select({ category: notificationPrefs.category, email: notificationPrefs.email })
			.from(notificationPrefs)
			.where(eq(notificationPrefs.membershipId, m.access.membershipId));
		const off = new Set(prefs.filter((p) => !p.email).map((p) => p.category));
		return {
			items,
			prefs: categories.map((c) => ({ category: c, label: NOTIFICATION_CATEGORIES[c], email: !off.has(c) }))
		};
	});
};

export const actions: Actions = {
	read: async ({ request, locals }) => {
		const m = requireMember(locals);
		const id = z.uuid().safeParse(field(await request.formData(), 'id'));
		if (!id.success) return { ok: false };
		await withTenant(userCtx(m), (tx) =>
			tx
				.update(notifications)
				.set({ readAt: now() })
				.where(and(eq(notifications.id, id.data), eq(notifications.membershipId, m.access.membershipId)))
		);
		return { ok: true };
	},
	readAll: async ({ locals }) => {
		const m = requireMember(locals);
		await withTenant(userCtx(m), (tx) =>
			tx
				.update(notifications)
				.set({ readAt: now() })
				.where(and(eq(notifications.membershipId, m.access.membershipId), isNull(notifications.readAt)))
		);
		return { ok: true };
	},
	prefs: async ({ request, locals }) => {
		const m = requireMember(locals);
		const form = await request.formData();
		const rows = categories.map((category) => ({
			tenantId: m.tenant.id,
			membershipId: m.access.membershipId,
			category,
			email: form.get(`email_${category}`) === 'on'
		}));
		await withTenant(userCtx(m), (tx) =>
			tx
				.insert(notificationPrefs)
				.values(rows)
				.onConflictDoUpdate({
					target: [notificationPrefs.tenantId, notificationPrefs.membershipId, notificationPrefs.category],
					set: { email: sql`excluded.email` }
				})
		);
		return { prefsSaved: true };
	}
};
