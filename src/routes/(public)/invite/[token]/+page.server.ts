import { error, fail, redirect } from '@sveltejs/kit';
import { setSessionCookies } from '#lib/server/auth/cookies.ts';
import { acceptInvitation, loadInvitation, registerFromInvitation } from '#lib/server/auth/service.ts';
import { config } from '#lib/server/config.ts';
import { actionError, field, limitedMessage } from '#lib/server/http/forms.ts';
import { hit } from '#lib/server/ratelimit.ts';
import { ssoForEmail } from '#lib/server/sso.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const inv = await loadInvitation(params.token);
	if (!inv) error(410, 'This invitation is invalid, already used or expired.');
	return {
		invitation: { tenantName: inv.tenantName, email: inv.email, userExists: inv.userExists },
		sso: !inv.userExists && (await ssoForEmail(inv.email))?.tenantId === inv.tenantId,
		signedInAs: locals.user?.email ?? null
	};
};

async function inviteLimit(ip: string) {
	const r = await hit('invite-ip', ip, config().RL_INVITE_PER_IP_HOUR, 3600_000);
	return r.ok ? null : fail(429, { message: limitedMessage(r.retryAfter) });
}

export const actions: Actions = {
	accept: async ({ params, locals, getClientAddress }) => {
		if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(`/invite/${params.token}`)}`);
		let slug: string;
		try {
			const limited = await inviteLimit(getClientAddress());
			if (limited) return limited;
			const inv = await loadInvitation(params.token);
			if (!inv) return fail(410, { message: 'This invitation is invalid, already used or expired.' });
			await acceptInvitation(params.token, locals.user.userId);
			slug = inv.tenantSlug;
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		redirect(303, `/t/${slug}`);
	},
	register: async ({ request, params, cookies, url, getClientAddress, locals }) => {
		const form = await request.formData();
		const name = field(form, 'name').trim();
		const password = field(form, 'password');
		if (!name || name.length > 120) return fail(400, { name, message: 'Enter your name (up to 120 characters).' });
		if (password !== field(form, 'confirm')) return fail(400, { name, message: 'The two passwords do not match.' });
		let slug: string;
		try {
			const limited = await inviteLimit(getClientAddress());
			if (limited) return limited;
			const s = await registerFromInvitation(
				params.token,
				{ name, password },
				{ ip: getClientAddress(), userAgent: request.headers.get('user-agent') }
			);
			setSessionCookies(cookies, url, s);
			slug = s.tenantSlug;
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		redirect(303, `/t/${slug}`);
	}
};
