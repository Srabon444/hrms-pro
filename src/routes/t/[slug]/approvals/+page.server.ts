import { pendingApprovals } from '#lib/server/approvals.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	return { items: await withTenant(userCtx(m), (tx) => pendingApprovals(tx, m.access)) };
};
