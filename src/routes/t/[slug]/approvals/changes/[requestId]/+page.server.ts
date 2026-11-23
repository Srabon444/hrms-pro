import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { decideChange, getChange } from '#lib/server/change-requests.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'employee.sensitive.update');
	const change = await withTenant(userCtx(m), (tx) => getChange(tx, m.access, params.requestId));
	if (!change) error(404, 'Not found');
	return { change };
};

export const actions: Actions = {
	default: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'employee.sensitive.update');
		try {
			await decideChange(m, params.requestId, formFields(await request.formData()));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { decided: true };
	}
};
