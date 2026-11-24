import { fail, redirect } from '@sveltejs/kit';
import { resetPassword } from '#lib/server/auth/service.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		const form = await request.formData();
		const password = field(form, 'password');
		if (password !== field(form, 'confirm')) return fail(400, { message: 'The two passwords do not match.' });
		try {
			await resetPassword(params.token, password);
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		redirect(303, '/login?notice=reset');
	}
};
