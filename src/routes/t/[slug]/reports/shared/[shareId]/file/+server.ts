import { error } from '@sveltejs/kit';
import { AppError } from '#lib/server/errors.ts';
import { downloadLimit } from '#lib/server/ratelimit.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import { reportCsv, reportFileName, reportPdf } from '#lib/server/reports/files.ts';
import { openShare } from '#lib/server/reports/shares.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, url }) => {
	const m = requireMember(locals);
	const format = url.searchParams.get('format');
	if (format !== 'csv' && format !== 'pdf') error(400, 'Choose CSV or PDF.');
	const limited = await downloadLimit(m.user.userId);
	if (limited) return limited;
	const { report } = await openShare(m, params.shareId).catch((err) => {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	});
	const body = format === 'csv' ? reportCsv(report) : new Uint8Array(await reportPdf(m.tenant.name, report));
	return new Response(body, {
		headers: {
			'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
			'content-disposition': `attachment; filename="${reportFileName(report, format)}"`,
			'x-content-type-options': 'nosniff',
			'cache-control': 'private, no-store'
		}
	});
};
