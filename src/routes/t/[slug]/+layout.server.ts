import { and, count, eq, isNull } from 'drizzle-orm';
import { allowedSettingsPages, NAV } from '#lib/nav.ts';
import { aiFeaturesOn } from '#lib/server/ai/settings.ts';
import { notifications } from '#lib/server/db/schema/index.ts';
import { can, requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { modulesOn } from '#lib/server/modules.ts';
import { tenantCurrency } from '#lib/server/settings.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	const { unread, currency, modules, ai } = await withTenant(userCtx(m), async (tx) => ({
		unread: (
			await tx
				.select({ unread: count() })
				.from(notifications)
				.where(and(eq(notifications.membershipId, m.access.membershipId), isNull(notifications.readAt)))
		)[0].unread,
		currency: await tenantCurrency(tx),
		modules: await modulesOn(tx),
		ai: await aiFeaturesOn(tx, m)
	}));
	return {
		tenant: { id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.name },
		membership: { status: locals.membership!.status },
		user: { id: m.user.userId, name: m.user.name, email: m.user.email },
		nav: NAV.filter(
			(item) =>
				(!item.self || m.access.employeeId) &&
				(!item.active || locals.membership!.status === 'active') &&
				(!item.module || modules.has(item.module)) &&
				(!item.ai || ai[item.ai]) &&
				(!item.perm || [item.perm].flat().some((p) => can(m.access, p)))
		).map(({ href, label, group }) => ({ href, label, group })),
		settingsMenu: allowedSettingsPages((perm) => can(m.access, perm)).map(({ href, label, group }) => ({
			href,
			label,
			group
		})),
		unread,
		currency,
		ai
	};
};
