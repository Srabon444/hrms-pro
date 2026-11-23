import { error } from '@sveltejs/kit';
import { config } from '#lib/server/config.ts';
import { AppError } from '#lib/server/errors.ts';
import { openReceipt } from '#lib/server/expenses.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import { hit } from '#lib/server/ratelimit.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const m = requireMember(locals);
	const limit = await hit('download', m.user.userId, config().RL_DOWNLOADS_PER_USER_MIN, 60_000).catch(() => null);
	if (limit && !limit.ok)
		return new Response('Too many downloads', { status: 429, headers: { 'retry-after': String(limit.retryAfter) } });
	try {
		const r = await openReceipt(m, params.itemId);
		return new Response(new Uint8Array(r.body), {
			headers: {
				'content-type': r.contentType,
				'content-length': String(r.body.byteLength),
				'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.fileName)}`,
				'x-content-type-options': 'nosniff',
				'cache-control': 'private, no-store'
			}
		});
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	}
};
