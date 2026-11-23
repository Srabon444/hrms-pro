import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { cancelLeave, decideLeave, getLeaveRequest } from '#lib/server/leave-requests.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requireMember(locals);
	const leave = await withTenant(userCtx(m), (tx) => getLeaveRequest(tx, m.access, params.requestId));
	if (!leave) error(404, 'Not found');
	return { leave };
};

export const actions: Actions = {
	decide: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		try {
			await decideLeave(m, params.requestId, formFields(await request.formData()));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { decided: true };
	},
	cancel: async ({ locals, params }) => {
		const m = requireMember(locals);
		try {
			await cancelLeave(m, params.requestId);
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { cancelled: true };
	}
};
