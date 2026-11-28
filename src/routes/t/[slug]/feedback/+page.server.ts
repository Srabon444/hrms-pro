import { error } from '@sveltejs/kit';
import { declineRequest, feedbackPage, giveFeedback, requestFeedback } from '#lib/server/feedback.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'one_on_ones');
	if (locals.membership?.status !== 'active') error(403, 'You do not have permission to do that.');
	return withTenant(userCtx(m), (tx) => feedbackPage(tx, m.access));
};

type Member = Awaited<ReturnType<typeof requireModule>>;

const run =
	(step: (m: Member, form: Record<string, string>) => Promise<unknown>, done: string): Actions[string] =>
	async ({ request, locals }) => {
		const m = await requireModule(locals, 'one_on_ones');
		const form = formFields(await request.formData());
		try {
			await step(m, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done };
	};

export const actions: Actions = {
	give: run((m, form) => giveFeedback(m, form), 'Feedback sent.'),
	request: run((m, form) => requestFeedback(m, form), 'Request sent.'),
	decline: run((m, form) => declineRequest(m, form.requestId ?? ''), 'Request declined.')
};
