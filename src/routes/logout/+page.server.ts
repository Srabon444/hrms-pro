import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE, clearSessionCookies } from '#lib/server/auth/cookies.ts';
import { deleteSession } from '#lib/server/auth/session.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => redirect(303, '/');

export const actions: Actions = {
	default: async ({ cookies, url }) => {
		await deleteSession(cookies.get(SESSION_COOKIE));
		clearSessionCookies(cookies, url);
		redirect(303, '/login?notice=signedout');
	}
};
