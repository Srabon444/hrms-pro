import { announcementFeed } from '#lib/server/announcements.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	if (locals.membership?.status !== 'active') return { announcements: [] };
	return { announcements: await withTenant(userCtx(m), (tx) => announcementFeed(tx, m.access, 5)) };
};
