import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { OPENING_STATUSES } from '#lib/server/db/schema/index.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { can, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { recruitmentBoard, saveOpening } from '#lib/server/recruitment.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'recruitment.read');
	return {
		board: await withTenant(userCtx(m), recruitmentBoard),
		canManage: can(m.access, 'recruitment.manage'),
		statuses: OPENING_STATUSES
	};
};

export const actions: Actions = {
	open: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'recruitment.manage');
		const form = formFields(await request.formData());
		let id: string;
		try {
			id = await saveOpening(userCtx(m), { ...form, openingId: '' });
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		redirect(303, `/t/${params.slug}/recruitment/${id}`);
	}
};
