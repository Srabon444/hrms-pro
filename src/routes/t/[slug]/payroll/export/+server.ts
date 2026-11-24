import { error } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { toCsv } from '#lib/server/csv.ts';
import { AppError } from '#lib/server/errors.ts';
import { exportPayroll } from '#lib/server/payroll-exports.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import { downloadLimit } from '#lib/server/ratelimit.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	const m = requireMember(locals);
	const limited = await downloadLimit(m.user.userId);
	if (limited) return limited;
	try {
		const { fileName, rows } = await exportPayroll(m, {
			runId: url.searchParams.get('run') ?? '',
			kind: url.searchParams.get('kind') ?? ''
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
