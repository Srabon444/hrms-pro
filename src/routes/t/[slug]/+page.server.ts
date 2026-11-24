import { homeDashboard } from '#lib/server/dashboard.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	return { home: locals.membership?.status === 'active' ? await homeDashboard(m) : null };
};
