import { redirect } from '@sveltejs/kit';
import { branches, departments } from '#lib/server/db/schema/index.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { tenantToday } from '#lib/server/lifecycle.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { createSurvey, SURVEY_MAX_QUESTIONS } from '#lib/server/surveys.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'surveys', 'survey.manage');
	return withTenant(userCtx(m), async (tx) => ({
		today: await tenantToday(tx),
		maxQuestions: SURVEY_MAX_QUESTIONS,
		departments: await tx
			.select({ id: departments.id, name: departments.name })
			.from(departments)
			.orderBy(departments.name),
		branches: await tx.select({ id: branches.id, name: branches.name }).from(branches).orderBy(branches.name)
	}));
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const m = await requireModule(locals, 'surveys', 'survey.manage');
		const form = formFields(await request.formData());
		let id: string;
		try {
			id = await createSurvey(m, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		redirect(303, `/t/${m.tenant.slug}/surveys/${id}`);
	}
};
