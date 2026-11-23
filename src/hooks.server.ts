import { redirect } from '@sveltejs/kit';
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { randomUUID } from 'node:crypto';
import { LAST_TENANT_COOKIE, SESSION_COOKIE, setLastTenant } from '#lib/server/auth/cookies.ts';
import { validateSession } from '#lib/server/auth/session.ts';
import { withTestNow } from '#lib/server/clock.ts';
import { config } from '#lib/server/config.ts';
import { log } from '#lib/server/log.ts';
import { httpDuration } from '#lib/server/metrics.ts';
import { loadAccess } from '#lib/server/rbac/access.ts';
import { hit } from '#lib/server/ratelimit.ts';
import { holdsRestricted } from '#lib/rbac/grants.ts';
import { resolveTenantAccess } from '#lib/server/tenancy/resolve.ts';

const securityHeaders: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=()',
	'cross-origin-opener-policy': 'same-origin'
};

const TENANT_PATH = /^\/t\/([^/]+)(?:\/|$)/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function mutationLimit(userId: string): Promise<Response | null> {
	try {
		const r = await hit('mutation', userId, config().RL_MUTATIONS_PER_USER_MIN, 60_000);
		if (r.ok) return null;
		return new Response('Too many requests', { status: 429, headers: { 'retry-after': String(r.retryAfter) } });
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'mutation rate limit unavailable; allowing request');
		return null;
	}
}

const route: Handle = async ({ event, resolve }) => {
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

	const slug = event.url.pathname.match(TENANT_PATH)?.[1];
	if (slug) {
		if (!user) redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
		const access = await resolveTenantAccess(slug, user.userId);
		if (access) {
			event.locals.tenant = access.tenant;
			event.locals.membership = access.membership;
			event.locals.access = await loadAccess(access.tenant.id, access.membership);
			if (access.tenant.require2faForSensitive && !user.totpEnabled && holdsRestricted(event.locals.access.grants))
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
	for (const [k, v] of Object.entries(securityHeaders)) response.headers.set(k, v);
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
		log.error({ err: input.error, requestId: event.locals.requestId, path: event.url.pathname }, 'unhandled error');
	return { requestId: event.locals.requestId };
};
