import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { randomUUID } from 'node:crypto';
import { log } from '#lib/server/log.ts';
import { httpDuration } from '#lib/server/metrics.ts';

const securityHeaders: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=()',
	'cross-origin-opener-policy': 'same-origin'
};

export const handle: Handle = async ({ event, resolve }) => {
	const started = performance.now();
	event.locals.requestId = randomUUID();
	const response = await resolve(event);
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
