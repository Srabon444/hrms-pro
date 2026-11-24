import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { filesFor } from '#lib/server/attachments.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { can, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { myInterviews, submitFeedback } from '#lib/server/recruitment.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'interview.feedback');
	return {
		...(await withTenant(userCtx(m), async (tx) => {
			const interviews = await myInterviews(tx, m.access.membershipId);
			const files = await filesFor(
				tx,
				'interview_feedback',
				interviews.map((i) => i.feedbackId)
			);
			return { interviews, files: Object.fromEntries(files) };
		})),
		canRead: can(m.access, 'recruitment.read')
	};
};

export const actions: Actions = {
	files: async ({ request, locals }) => {
		const m = requirePerm(locals, 'interview.feedback');
		const form = await request.formData();
		return attachmentAction(m, form, 'interview_feedback', field(form, 'ownerId'), locals.requestId);
	},
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
