import { error } from '@sveltejs/kit';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { reportsFor } from '#lib/server/reports/index.ts';
import { shareList } from '#lib/server/reports/shares.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	const reports = reportsFor(m.access);
	if (!reports.length) error(403, 'You do not have permission to do that.');
	return { reports, shares: await withTenant(userCtx(m), (tx) => shareList(tx, m.access)) };
};
