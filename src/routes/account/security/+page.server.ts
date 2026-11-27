import { error, fail, redirect } from '@sveltejs/kit';
import { API_REAUTH_MINUTES } from '#lib/server/api-keys.ts';
import { setSessionCookies } from '#lib/server/auth/cookies.ts';
import {
	beginTotpEnrolment,
	changePassword,
	confirmRecentAuth,
	confirmTotpEnrolment,
	disableTotp
} from '#lib/server/auth/service.ts';
import { recentlyAuthed, requireRecentAuth } from '#lib/server/auth/session.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { ssoMessage, ssoLinks, unlinkSso } from '#lib/server/sso.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	const sso = url.searchParams.get('sso');
	return {
		totpEnabled: locals.user.totpEnabled,
		email: locals.user.email,
		required: url.searchParams.has('required'),
		locked: !!locals.user.ssoTenantId,
		links: await ssoLinks(locals.user.userId),
		recent: await recentlyAuthed(locals.user.sessionId, API_REAUTH_MINUTES),
		linkedNow: url.searchParams.has('linked'),
		ssoError: ssoMessage(sso)
	};
};

const signedIn = (locals: App.Locals) => {
	if (!locals.user) redirect(303, '/login');
	if (locals.user.ssoTenantId) error(403, 'Sign in with your password to change security settings.');
	return locals.user;
};

export const actions: Actions = {
	reauth: async ({ request, locals }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		try {
			await confirmRecentAuth(user, field(form, 'password'), field(form, 'code'));
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { confirmed: true };
	},
	unlink: async ({ request, locals }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		try {
			await requireRecentAuth(user.sessionId, API_REAUTH_MINUTES);
			await unlinkSso(user.userId, field(form, 'tenantId'));
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { unlinked: true };
	},
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
