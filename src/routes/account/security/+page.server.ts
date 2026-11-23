import { fail, redirect } from '@sveltejs/kit';
import { setSessionCookies } from '#lib/server/auth/cookies.ts';
import { beginTotpEnrolment, changePassword, confirmTotpEnrolment, disableTotp } from '#lib/server/auth/service.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	return {
		totpEnabled: locals.user.totpEnabled,
		email: locals.user.email,
		required: url.searchParams.has('required')
	};
};

const signedIn = (locals: App.Locals) => {
	if (!locals.user) redirect(303, '/login');
	return locals.user;
};

export const actions: Actions = {
	begin: async ({ locals }) => {
		const user = signedIn(locals);
		try {
			return { enrol: await beginTotpEnrolment(user.userId, user.email) };
		} catch (err) {
			return actionError(err, locals.requestId);
		}
	},
	confirm: async ({ request, locals }) => {
		const user = signedIn(locals);
		const code = field(await request.formData(), 'code');
		try {
			return { recoveryCodes: await confirmTotpEnrolment(user.userId, code) };
		} catch (err) {
			return actionError(err, locals.requestId);
		}
	},
	disable: async ({ request, locals }) => {
		const user = signedIn(locals);
		try {
			await disableTotp(user.userId, field(await request.formData(), 'password'));
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { disabled: true };
	},
	password: async ({ request, locals, cookies, url, getClientAddress }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		const next = field(form, 'next');
		if (next !== field(form, 'confirm')) return fail(400, { message: 'The two new passwords do not match.' });
		try {
			const s = await changePassword(user.userId, field(form, 'current'), next, {
				ip: getClientAddress(),
				userAgent: request.headers.get('user-agent')
			});
			setSessionCookies(cookies, url, s);
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { passwordChanged: true };
	}
};
