import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Permission } from '#lib/rbac/permissions.ts';
import { filesFor, listFiles } from '#lib/server/attachments.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import {
	finaliseReview,
	removeGoal,
	reviewView,
	saveGoal,
	shareReview,
	submitManager,
	submitSelf
} from '#lib/server/performance.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'performance.read');
	const page = await withTenant(userCtx(m), async (tx) => {
		const view = await reviewView(tx, m.access, params.reviewId);
		if (!view) return null;
		return {
			view,
			attachments: await listFiles(tx, m.access, 'review', params.reviewId),
			goalFiles: Object.fromEntries(
				await filesFor(
					tx,
					'goal',
					view.goals.map((g) => g.id)
				)
			)
		};
	});
	if (!page) error(404, 'That review does not exist.');
	return page;
};

type Step = (m: ReturnType<typeof requirePerm>, form: Record<string, string>) => Promise<unknown>;

const act = (permission: Permission, step: Step, done: string) => async (event: RequestEvent) => {
	const m = requirePerm(event.locals, permission);
	const form = { ...formFields(await event.request.formData()), reviewId: event.params.reviewId };
	try {
		const mails = await step(m, form);
		if (Array.isArray(mails)) await sendAll(mails);
		return { done };
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, event.locals.requestId);
	}
};

export const actions: Actions = {
	files: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'performance.read');
		return attachmentAction(m, await request.formData(), 'review', params.reviewId, locals.requestId);
	},
	goalFiles: async ({ request, locals }) => {
		const m = requirePerm(locals, 'performance.read');
		const form = await request.formData();
		return attachmentAction(m, form, 'goal', field(form, 'ownerId'), locals.requestId);
	},
	goal: act('performance.read', saveGoal, 'Goal saved.'),
	remove: act('performance.read', removeGoal, 'Goal removed.'),
	self: act('performance.read', submitSelf, 'Self review sent to your manager.'),
	manager: act('performance.review', submitManager, 'Rating sent to HR.'),
	finalise: act('performance.manage', finaliseReview, 'Review finalised.'),
	share: act('performance.manage', shareReview, 'Review shared with the employee.')
};
