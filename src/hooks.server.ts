import { error, redirect } from '@sveltejs/kit';
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { randomUUID } from 'node:crypto';
import { LAST_TENANT_COOKIE, SESSION_COOKIE, setLastTenant } from '#lib/server/auth/cookies.ts';
import { validateSession } from '#lib/server/auth/session.ts';
import { withTestNow } from '#lib/server/clock.ts';
import { config } from '#lib/server/config.ts';
import { log } from '#lib/server/log.ts';
import { httpDuration } from '#lib/server/metrics.ts';
import { loadAccess } from '#lib/server/rbac/access.ts';
import { hitOrLocal } from '#lib/server/ratelimit.ts';
import { holdsRestricted } from '#lib/rbac/grants.ts';
import { resolveTenantAccess } from '#lib/server/tenancy/resolve.ts';

const securityHeaders: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(self)',
	'cross-origin-opener-policy': 'same-origin'
};

const TENANT_PATH = /^\/t\/([^/]+)(?:\/|$)/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function mutationLimit(userId: string): Promise<Response | null> {
	const r = await hitOrLocal('mutation', userId, config().RL_MUTATIONS_PER_USER_MIN, 60_000);
	if (r.ok) return null;
	return new Response('Too many requests', { status: 429, headers: { 'retry-after': String(r.retryAfter) } });
}

const FORM_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

const route: Handle = async ({ event, resolve }) => {
	const type = event.request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
	if (!SAFE_METHODS.has(event.request.method) && !event.url.pathname.startsWith('/api/') && !FORM_TYPES.has(type))
		return new Response('Unsupported content type', { status: 415 });
	event.locals.user = await validateSession(event.cookies.get(SESSION_COOKIE)).catch((err) => {
		log.error({ err, requestId: event.locals.requestId }, 'session validation failed');
		return null;
	});
	event.locals.tenant = null;
	event.locals.membership = null;
	event.locals.access = null;
	const user = event.locals.user;

	if (user && !SAFE_METHODS.has(event.request.method)) {
		const limited = await mutationLimit(user.userId);
		if (limited) return limited;
	}

	if (user?.ssoTenantId && event.route.id?.startsWith('/platform'))
		error(403, 'Sign in with your password to use the platform console.');

	const slug =
		(event.route.id?.startsWith('/t/[slug]') ? event.params.slug : undefined) ??
		event.url.pathname.match(TENANT_PATH)?.[1];
	if (slug) {
		const here = encodeURIComponent(event.url.pathname + event.url.search);
		if (!user) redirect(303, `/login?next=${here}`);
		const access = await resolveTenantAccess(slug, user.userId);
		if (access) {
			const ssoHere = user.ssoTenantId === access.tenant.id;
			if (user.ssoTenantId && !ssoHere) redirect(303, `/login?next=${here}&notice=other_org`);
			event.locals.tenant = access.tenant;
			event.locals.membership = access.membership;
			event.locals.access = await loadAccess(access.tenant.id, access.membership);
			if (
				access.tenant.ssoEnforced &&
				!ssoHere &&
				access.membership.status === 'active' &&
				!(event.locals.access.isOwner && user.totpEnabled)
			)
				redirect(303, `/sso/start?t=${access.tenant.id}&next=${here}`);
			if (
				access.tenant.require2faForSensitive &&
				!user.totpEnabled &&
				!ssoHere &&
				holdsRestricted(event.locals.access.grants)
			)
				redirect(303, '/account/security?required=1');
			if (event.cookies.get(LAST_TENANT_COOKIE) !== slug) setLastTenant(event.cookies, event.url, slug);
		}
	}
	return resolve(event);
};

export const handle: Handle = async ({ event, resolve }) => {
	const started = performance.now();
	event.locals.requestId = randomUUID();
	const response = await withTestNow(event.request.headers.get('x-test-now'), () => route({ event, resolve }));
	for (const [k, v] of Object.entries(securityHeaders)) if (!response.headers.has(k)) response.headers.set(k, v);
	response.headers.set('x-request-id', event.locals.requestId);
	if (event.url.protocol === 'https:')
		response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
	httpDuration.observe(
		{ method: event.request.method, route: event.route.id ?? 'unmatched', status: String(response.status) },
		(performance.now() - started) / 1000
	);
	return response;
};

export const handleError: HandleServerError = (input) => {
	const { event } = input;
	if (input.kind === 'unknown')
		log.error(
			{
				err: input.error,
				requestId: event.locals.requestId,
				path: event.url.pathname.replace(/^\/ical\/.*/, '/ical/[file]').replace(/^\/sign\/[^/]+/, '/sign/[token]')
			},
			'unhandled error'
		);
	return { requestId: event.locals.requestId };
};
