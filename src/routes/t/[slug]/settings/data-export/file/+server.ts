import { error } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { toCsv } from '#lib/server/csv.ts';
import { exportDataset } from '#lib/server/data-export.ts';
import { AppError } from '#lib/server/errors.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import { downloadLimit } from '#lib/server/ratelimit.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	const m = requirePerm(locals, 'data.export');
	const limited = await downloadLimit(m.user.userId);
	if (limited) return limited;
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
