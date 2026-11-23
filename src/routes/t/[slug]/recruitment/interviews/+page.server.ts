import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { can, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { myInterviews, submitFeedback } from '#lib/server/recruitment.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'interview.feedback');
	return {
		interviews: await withTenant(userCtx(m), (tx) => myInterviews(tx, m.access.membershipId)),
		canRead: can(m.access, 'recruitment.read')
	};
};

export const actions: Actions = {
	feedback: async ({ request, locals }) => {
		const m = requirePerm(locals, 'interview.feedback');
		const form = formFields(await request.formData());
		try {
			await submitFeedback(userCtx(m), m.access.membershipId, form);
			return { done: 'Feedback sent.' };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
	}
};
