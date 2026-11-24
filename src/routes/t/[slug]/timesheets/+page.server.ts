import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { logTime, myWeek, removeEntry, submitWeek, timesheetApprovals } from '#lib/server/timesheets.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requireMember(locals);
	return withTenant(userCtx(m), async (tx) => ({
		week: await myWeek(tx, m.access, url.searchParams.get('week')),
		waiting: await timesheetApprovals(tx, m.access)
	}));
};

const act =
	(
		step: (m: ReturnType<typeof requireMember>, raw: Record<string, string>) => Promise<unknown>,
		done: string
	): Actions[string] =>
	async ({ request, locals }) => {
		const m = requireMember(locals);
		const form = formFields(await request.formData());
		try {
			const mails = await step(m, form);
			if (Array.isArray(mails)) await sendAll(mails);
			return { done };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
	};

export const actions: Actions = {
	log: act(logTime, 'Time logged.'),
	remove: act(removeEntry, 'Entry removed.'),
	submit: act(submitWeek, 'Timesheet submitted for approval.')
};
