import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { canSetUpLetters, LETTER_PLACEHOLDERS, saveTemplate, templateList } from '#lib/server/letters.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'letter.issue');
	if (!canSetUpLetters(m.access)) error(403, 'You do not have permission to do that.');
	return {
		templates: await withTenant(userCtx(m), (tx) => templateList(tx)),
		placeholders: LETTER_PLACEHOLDERS
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const m = requirePerm(locals, 'letter.issue');
		const form = formFields(await request.formData());
		try {
			await saveTemplate(m, { ...form, templateId: '' });
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
		redirect(303, `/t/${m.tenant.slug}/settings/letters`);
	}
};
