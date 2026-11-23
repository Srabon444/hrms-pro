import { fail, redirect } from '@sveltejs/kit';
import { CHALLENGE_COOKIE, safeNext, setChallengeCookie, setSessionCookies } from '#lib/server/auth/cookies.ts';
import { getChallenge } from '#lib/server/auth/challenge.ts';
import { verifyChallenge } from '#lib/server/auth/service.ts';
import { actionError, field, limitedMessage } from '#lib/server/http/forms.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, url }) => {
	const c = await getChallenge(cookies.get(CHALLENGE_COOKIE)).catch(() => null);
	if (!c) redirect(303, '/login?notice=expired');
	return { stage: c.stage, next: safeNext(url.searchParams.get('next')) };
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress, locals }) => {
		const form = await request.formData();
		const next = safeNext(field(form, 'next'));
		let result;
		try {
			result = await verifyChallenge(cookies.get(CHALLENGE_COOKIE), field(form, 'code'), {
				ip: getClientAddress(),
				userAgent: request.headers.get('user-agent')
			});
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		switch (result.kind) {
			case 'session':
				setSessionCookies(cookies, url, result);
				return redirect(303, next);
			case 'challenge':
				setChallengeCookie(cookies, url, result.challengeId);
				return redirect(303, `/login/verify?next=${encodeURIComponent(next)}`);
			case 'wrong':
				return fail(400, { message: `That code is not valid. ${result.remaining} attempts left.` });
			case 'limited':
				return fail(429, { message: limitedMessage(result.retryAfter) });
			default:
				redirect(303, '/login?notice=expired');
		}
	}
};
