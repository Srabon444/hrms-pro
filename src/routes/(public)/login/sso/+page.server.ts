import { fail } from '@sveltejs/kit';
import { safeNext } from '#lib/server/auth/cookies.ts';
import { field, limitedMessage } from '#lib/server/http/forms.ts';
import { hitOrLocal } from '#lib/server/ratelimit.ts';
import { ssoForEmail } from '#lib/server/sso.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => ({ next: safeNext(url.searchParams.get('next')) });

export const actions: Actions = {
	default: async ({ request, getClientAddress }) => {
		const form = await request.formData();
		const email = field(form, 'email');
		const next = safeNext(field(form, 'next'));
		const limited = await hitOrLocal('sso-find', getClientAddress(), 30, 600_000);
		if (!limited.ok) return fail(429, { email, message: limitedMessage(limited.retryAfter) });
		const found = await ssoForEmail(email);
		if (!found)
			return fail(400, { email, message: 'Company sign-in is not set up for that email. Sign in with your password.' });
		return { email, href: `/sso/start?t=${found.tenantId}&next=${encodeURIComponent(next)}` };
	}
};
