import { error, redirect } from '@sveltejs/kit';
import { AppError } from '#lib/server/errors.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import {
	closeSurvey,
	deleteSurvey,
	openSurvey,
	remindSurvey,
	submitSurvey,
	surveyPage,
	surveyResults
} from '#lib/server/surveys.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const m = await requireModule(locals, 'surveys');
	try {
		return await withTenant(userCtx(m), async (tx) => {
			const page = await surveyPage(tx, m.access, params.id);
			return {
				...page,
				results: page.manager ? await surveyResults(tx, m.access, params.id, url.searchParams.get('by')) : null
			};
		});
	} catch (err) {
		if (err instanceof AppError && err.status === 404) error(404, 'Not found');
		throw err;
	}
};

const manage =
	(fn: (m: Awaited<ReturnType<typeof requireModule>>, id: string) => Promise<unknown>, done: string) =>
	async ({ locals, params }: { locals: App.Locals; params: { id: string } }) => {
		const m = await requireModule(locals, 'surveys', 'survey.manage');
		try {
			await fn(m, params.id);
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		return { done };
	};

export const actions: Actions = {
	answer: async ({ request, locals, params }) => {
		const m = await requireModule(locals, 'surveys');
		const form = formFields(await request.formData());
		try {
			await submitSurvey(m, params.id, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done: 'Thank you. Your answers were saved.' };
	},
	open: manage(openSurvey, 'The survey is open and everyone asked was told.'),
	close: manage(closeSurvey, 'The survey is closed.'),
	remind: manage(remindSurvey, 'A reminder went to everyone who has not answered.'),
	delete: async ({ locals, params }) => {
		const m = await requireModule(locals, 'surveys', 'survey.manage');
		try {
			await deleteSurvey(m, params.id);
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		redirect(303, `/t/${m.tenant.slug}/surveys`);
	}
};
