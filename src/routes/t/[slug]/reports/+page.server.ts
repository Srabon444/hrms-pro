import { error } from '@sveltejs/kit';
import { requireMember } from '#lib/server/rbac/access.ts';
import { reportsFor } from '#lib/server/reports/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const reports = reportsFor(requireMember(locals).access);
	if (!reports.length) error(403, 'You do not have permission to do that.');
	return { reports };
};
