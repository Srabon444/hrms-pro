import { requestPasswordReset } from '#lib/server/auth/service.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ request, getClientAddress, locals }) => {
		const form = await request.formData();
		try {
			await requestPasswordReset(field(form, 'email'), getClientAddress());
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { sent: true };
	}
};
