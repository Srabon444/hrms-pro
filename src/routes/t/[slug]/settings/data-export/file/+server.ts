import { error } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { config } from '#lib/server/config.ts';
import { toCsv } from '#lib/server/csv.ts';
import { exportDataset } from '#lib/server/data-export.ts';
import { AppError } from '#lib/server/errors.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import { hit } from '#lib/server/ratelimit.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	const m = requirePerm(locals, 'data.export');
	const limit = await hit('download', m.user.userId, config().RL_DOWNLOADS_PER_USER_MIN, 60_000).catch(() => null);
	if (limit && !limit.ok)
		return new Response('Too many downloads', { status: 429, headers: { 'retry-after': String(limit.retryAfter) } });
	try {
		const { fileName, rows } = await exportDataset(m, {
			dataset: url.searchParams.get('dataset') ?? '',
			from: url.searchParams.get('from') ?? '',
			to: url.searchParams.get('to') ?? ''
		});
		return new Response(toCsv(rows), {
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="${fileName}"`,
				'x-content-type-options': 'nosniff',
				'cache-control': 'private, no-store'
			}
		});
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		if (err instanceof ZodError) error(400, err.issues[0].message);
		throw err;
	}
};
