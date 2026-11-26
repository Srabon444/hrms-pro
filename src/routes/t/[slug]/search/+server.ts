import { json } from '@sveltejs/kit';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { searchLimit } from '#lib/server/ratelimit.ts';
import { globalSearch, searchQuery } from '#lib/server/search.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { RequestHandler } from './$types';

const headers = { 'cache-control': 'private, no-store' };

export const GET: RequestHandler = async ({ locals, url }) => {
	const m = requireMember(locals);
	const q = searchQuery.safeParse(url.searchParams.get('q') ?? '');
	if (!q.success) return json({ hits: [] }, { headers });
	const limited = await searchLimit(m.access.membershipId);
	if (limited) return limited;
	const viewer = { access: m.access, active: locals.membership?.status === 'active' };
	const hits = await withTenant(userCtx(m), (tx) => globalSearch(tx, viewer, q.data));
	return json({ hits }, { headers });
};
