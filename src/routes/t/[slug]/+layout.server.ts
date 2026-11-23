import { and, count, eq, isNull } from 'drizzle-orm';
import { NAV } from '#lib/nav.ts';
import { notifications } from '#lib/server/db/schema/index.ts';
import { can, requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	const [{ unread }] = await withTenant(userCtx(m), (tx) =>
		tx
			.select({ unread: count() })
			.from(notifications)
			.where(and(eq(notifications.membershipId, m.access.membershipId), isNull(notifications.readAt)))
	);
	return {
		tenant: { id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.name },
		membership: { status: locals.membership!.status },
		user: { name: m.user.name, email: m.user.email },
		nav: NAV.filter((item) => !item.perm || can(m.access, item.perm)).map(({ href, label }) => ({ href, label })),
		unread
	};
};
