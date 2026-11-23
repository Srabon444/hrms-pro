import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { AppError } from '#lib/server/errors.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { can, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { candidateView, moveCandidate } from '#lib/server/recruitment.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'recruitment.read');
	try {
		return {
			view: await withTenant(userCtx(m), (tx) => candidateView(tx, params.candidateId)),
			canManage: can(m.access, 'recruitment.manage')
		};
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	}
};

export const actions: Actions = {
	move: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'recruitment.manage');
		const form = formFields(await request.formData());
		try {
			await moveCandidate(userCtx(m), { ...form, candidateId: params.candidateId });
			return { done: 'Candidate moved.' };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
	}
};
