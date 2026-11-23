import { listAudit } from '#lib/server/audit.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) =>
	listAudit(requirePerm(locals, 'audit.read'), {
		table: url.searchParams.get('table'),
		before: url.searchParams.get('before')
	});
