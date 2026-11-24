import { employeeChoices, listEmployees } from '#lib/server/employees.ts';
import { can, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requirePerm(locals, 'employee.read');
	return withTenant(userCtx(m), async (tx) => ({
		...(await listEmployees(tx, m.access, Object.fromEntries(url.searchParams))),
		departments: (await employeeChoices(tx)).departments,
		canCreate: can(m.access, 'employee.create')
	}));
};
