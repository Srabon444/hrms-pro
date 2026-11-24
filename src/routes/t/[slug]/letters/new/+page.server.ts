import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { AppError } from '#lib/server/errors.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { issueLetter, letterPreview } from '#lib/server/letters.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requirePerm(locals, 'letter.issue');
	try {
		return await letterPreview(m, url.searchParams.get('employeeId') ?? '', url.searchParams.get('templateId') ?? '');
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	}
};

export const actions: Actions = {
	issue: async ({ request, locals }) => {
		const m = requirePerm(locals, 'letter.issue');
		const form = formFields(await request.formData());
		try {
			const issued = await issueLetter(m, form);
			await sendAll(issued.mails);
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
		redirect(303, `/t/${m.tenant.slug}/letters`);
	}
};
