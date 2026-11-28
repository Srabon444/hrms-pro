import { learningReport, verifyCertificate } from '#lib/server/learning.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'learning', 'course.report');
	return withTenant(userCtx(m), (tx) => learningReport(tx, m.access));
};

export const actions: Actions = {
	verify: async ({ request, locals }) => {
		const m = await requireModule(locals, 'learning', 'course.report');
		const form = formFields(await request.formData());
		try {
			return { verified: await withTenant(userCtx(m), (tx) => verifyCertificate(tx, m.access, form.code ?? '')) };
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
	}
};
