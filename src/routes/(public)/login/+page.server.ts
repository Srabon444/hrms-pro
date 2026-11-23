import { fail, redirect } from '@sveltejs/kit';
import { DEVICE_COOKIE, safeNext, setChallengeCookie, setSessionCookies } from '#lib/server/auth/cookies.ts';
import { login } from '#lib/server/auth/service.ts';
import { actionError, field, limitedMessage } from '#lib/server/http/forms.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) redirect(303, safeNext(url.searchParams.get('next')));
	return { next: safeNext(url.searchParams.get('next')), notice: url.searchParams.get('notice') };
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress, locals }) => {
		const form = await request.formData();
		const email = field(form, 'email');
		const next = safeNext(field(form, 'next'));
		let result;
		try {
			result = await login({
				email,
				password: field(form, 'password'),
				meta: { ip: getClientAddress(), userAgent: request.headers.get('user-agent') },
				trustedDevice: cookies.get(DEVICE_COOKIE)
			});
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		if (result.kind === 'invalid') return fail(400, { email, message: 'Email or password is incorrect.' });
		if (result.kind === 'limited') return fail(429, { email, message: limitedMessage(result.retryAfter) });
		if (result.kind === 'challenge') {
			setChallengeCookie(cookies, url, result.challengeId);
			redirect(303, `/login/verify?next=${encodeURIComponent(next)}`);
		}
		setSessionCookies(cookies, url, result);
		redirect(303, next);
	}
};
