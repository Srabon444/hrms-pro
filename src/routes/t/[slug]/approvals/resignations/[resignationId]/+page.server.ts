import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { listFiles } from '#lib/server/attachments.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { decideResignation, getResignation } from '#lib/server/resignations.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requireMember(locals);
	const { resignation, attachments } = await withTenant(userCtx(m), async (tx) => ({
		resignation: await getResignation(tx, m.access, params.resignationId),
		attachments: await listFiles(tx, m.access, 'resignation', params.resignationId)
	}));
	if (!resignation) error(404, 'Not found');
	return { resignation, attachments };
};

export const actions: Actions = {
	default: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		try {
			await decideResignation(m, params.resignationId, formFields(await request.formData()));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { decided: true };
	}
};
