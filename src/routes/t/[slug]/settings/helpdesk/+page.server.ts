import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { categoryOptions, saveCategory } from '#lib/server/helpdesk.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm, scopesOf, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'helpdesk.manage');
	return {
		categories: await withTenant(userCtx(m), (tx) => categoryOptions(tx, true)),
		canConfidential: scopesOf(m.access, 'helpdesk.confidential').includes('all')
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const m = requirePerm(locals, 'helpdesk.manage');
		const form = formFields(await request.formData());
		try {
			await saveCategory(m, form);
			return { done: 'Category saved.' };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
	}
};
