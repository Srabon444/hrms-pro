import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE, setSessionCookies } from '#lib/server/auth/cookies.ts';
import { deleteSession } from '#lib/server/auth/session.ts';
import { AppError } from '#lib/server/errors.ts';
import { log } from '#lib/server/log.ts';
import { hitOrLocal } from '#lib/server/ratelimit.ts';
import { finishSso, SSO_COOKIE, type SsoResult } from '#lib/server/sso.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies, request, getClientAddress, locals }) => {
	const bind = cookies.get(SSO_COOKIE);
	cookies.delete(SSO_COOKIE, { path: '/sso', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:' });
	if (url.searchParams.get('error')) redirect(303, '/login?sso=sso_cancelled');
	if (!(await hitOrLocal('sso-callback', getClientAddress(), 60, 600_000)).ok) redirect(303, '/login?sso=sso_failed');
	let result: SsoResult;
	try {
		result = await finishSso({
			state: url.searchParams.get('state'),
			code: url.searchParams.get('code'),
			bind,
			meta: { ip: getClientAddress(), userAgent: request.headers.get('user-agent') }
		});
	} catch (err) {
		if (!(err instanceof AppError)) log.error({ err, requestId: locals.requestId }, 'sso callback failed');
		const code = err instanceof AppError ? err.code : 'sso_failed';
		redirect(303, `/${code === 'already_linked' ? 'account/security' : 'login'}?sso=${code}`);
	}
	if (result.kind === 'linked') redirect(303, '/account/security?linked=1');
	await deleteSession(cookies.get(SESSION_COOKIE));
	setSessionCookies(cookies, url, result);
	redirect(303, result.next);
};
