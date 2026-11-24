import { pendingApprovals } from '#lib/server/approvals.ts';
import { can, requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	return {
		items: await withTenant(userCtx(m, { salaryAll: can(m.access, 'salary.approve') }), (tx) =>
			pendingApprovals(tx, m.access)
		)
	};
};
