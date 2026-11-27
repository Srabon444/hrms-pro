import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { API_REAUTH_MINUTES } from '#lib/server/api-keys.ts';
import { loadInvitation } from '#lib/server/auth/service.ts';
import { recentlyAuthed } from '#lib/server/auth/session.ts';
import { safeNext } from '#lib/server/auth/cookies.ts';
import { AppError } from '#lib/server/errors.ts';
import { hitOrLocal } from '#lib/server/ratelimit.ts';
import { SSO_COOKIE, SSO_ORIGINS, SSO_STATE_SECONDS, ssoForEmail, startSso } from '#lib/server/sso.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals, cookies, getClientAddress }) => {
	const limited = await hitOrLocal('sso-start', getClientAddress(), 60, 600_000);
	if (!limited.ok) error(429, 'Too many sign-in attempts. Try again in a few minutes.');
	const invite = url.searchParams.get('invite');
	const link = url.searchParams.get('link') === '1';
	let tenantId = z.uuid().safeParse(url.searchParams.get('t')).data ?? null;
	let next = safeNext(url.searchParams.get('next'));
	if (invite) {
		const inv = await loadInvitation(invite);
		if (!inv) redirect(303, '/login?sso=invitation_invalid');
		tenantId = (await ssoForEmail(inv.email))?.tenantId ?? null;
		if (tenantId !== inv.tenantId) redirect(303, `/invite/${encodeURIComponent(invite)}`);
		next = `/t/${inv.tenantSlug}`;
	}
	if (!tenantId) redirect(303, '/login?sso=sso_off');
	if (link) {
		if (!locals.user || locals.user.ssoTenantId) redirect(303, '/login?next=/account/security');
		if (!(await recentlyAuthed(locals.user.sessionId, API_REAUTH_MINUTES))) redirect(303, '/account/security?reauth=1');
		next = '/account/security';
	}
	let started;
	try {
		started = await startSso({
			tenantId,
			next,
			linkUserId: link ? locals.user!.userId : null,
			invite: invite ?? null
		});
	} catch (err) {
		if (err instanceof AppError) redirect(303, `/login?sso=${err.code}`);
		throw err;
	}
	cookies.set(SSO_COOKIE, started.bind, {
		path: '/sso',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: SSO_STATE_SECONDS
	});
	redirect(303, started.url, { external: SSO_ORIGINS });
};
