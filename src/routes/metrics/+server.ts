import { error } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { config } from '#lib/server/config.ts';
import { registry } from '#lib/server/metrics.ts';

function authorized(header: string | null): boolean {
	const expected = Buffer.from(`Bearer ${config().METRICS_TOKEN}`);
	const given = Buffer.from(header ?? '');
	return given.length === expected.length && timingSafeEqual(given, expected);
}

export const GET = async ({ request }) => {
	if (!authorized(request.headers.get('authorization'))) error(401, 'Unauthorized');
	return new Response(await registry.metrics(), { headers: { 'content-type': registry.contentType } });
};
