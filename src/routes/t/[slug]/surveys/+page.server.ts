import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { submitSuggestion, surveysPage } from '#lib/server/surveys.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'surveys');
	return withTenant(userCtx(m), (tx) => surveysPage(tx, m.access));
};

export const actions: Actions = {
	suggest: async ({ request, locals }) => {
		const m = await requireModule(locals, 'surveys');
		const form = formFields(await request.formData());
		try {
			await submitSuggestion(m, form.suggestion ?? '');
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { suggested: true };
	}
};
