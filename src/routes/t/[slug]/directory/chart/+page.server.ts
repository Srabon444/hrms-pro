import { chartStart, departmentLevel } from '#lib/server/directory.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = await requireModule(locals, 'directory', 'directory.read');
	const view = url.searchParams.get('view') === 'departments' ? 'departments' : 'people';
	return withTenant(userCtx(m), async (tx) => ({
		view,
		me: m.access.employeeId,
		people: view === 'people' ? await chartStart(tx) : null,
		units: view === 'departments' ? await departmentLevel(tx, null) : null
	}));
};
