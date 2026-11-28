import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { suggestionsPage } from '#lib/server/surveys.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'surveys', 'survey.manage');
	return withTenant(userCtx(m), (tx) => suggestionsPage(tx, m.access, m.tenant.id));
};
