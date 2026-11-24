import { exportableDatasets } from '#lib/server/data-export.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'data.export');
	return { datasets: exportableDatasets(m.access) };
};
