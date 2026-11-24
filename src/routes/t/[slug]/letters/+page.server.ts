import { letterBoard } from '#lib/server/letters.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	return withTenant(userCtx(m), (tx) => letterBoard(tx, m.access));
};
