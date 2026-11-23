import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { decideTimesheet, timesheetView } from '#lib/server/timesheets.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requireMember(locals);
	const view = await withTenant(userCtx(m), (tx) => timesheetView(tx, m.access, params.timesheetId));
	if (!view) error(404, 'That timesheet does not exist.');
	return { view };
};

export const actions: Actions = {
	decide: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		const form = formFields(await request.formData());
		try {
			await sendAll(await decideTimesheet(m, params.timesheetId, form));
			return { done: form.decision === 'approved' ? 'Timesheet approved.' : 'Timesheet sent back.' };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
	}
};
