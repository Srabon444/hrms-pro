import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { CANDIDATE_SOURCES, OPENING_STATUSES } from '#lib/server/db/schema/index.ts';
import { AppError } from '#lib/server/errors.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { can, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { addCandidate, openingView, saveOpening } from '#lib/server/recruitment.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'recruitment.read');
	try {
		return {
			view: await withTenant(userCtx(m), (tx) => openingView(tx, params.openingId)),
			canManage: can(m.access, 'recruitment.manage'),
			statuses: OPENING_STATUSES,
			sources: CANDIDATE_SOURCES
		};
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	}
};

const fieldsOf = async (request: Request) => {
	const data = await request.formData();
	const file = data.get('resume');
	return { form: formFields(data), file: file instanceof File ? file : null };
};

export const actions: Actions = {
	save: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'recruitment.manage');
		const { form } = await fieldsOf(request);
		try {
			await saveOpening(userCtx(m), { ...form, openingId: params.openingId });
			return { done: 'Opening saved.' };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
	},
	add: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'recruitment.manage');
		const { form, file } = await fieldsOf(request);
		try {
			await addCandidate(userCtx(m), { ...form, openingId: params.openingId }, file);
			return { done: 'Candidate added.' };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
	}
};
