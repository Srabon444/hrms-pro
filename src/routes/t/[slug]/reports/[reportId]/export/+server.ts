import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { auditEvent } from '#lib/server/audit.ts';
import { AppError } from '#lib/server/errors.ts';
import { downloadLimit } from '#lib/server/ratelimit.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import { reportCsv, reportFileName, reportPdf } from '#lib/server/reports/files.ts';
import { reportCtx, runReport } from '#lib/server/reports/index.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, url }) => {
	const m = requireMember(locals);
	const { format, ...filters } = Object.fromEntries(url.searchParams);
	if (format !== 'csv' && format !== 'pdf') error(400, 'Choose CSV or PDF.');
	const limited = await downloadLimit(m.user.userId);
	if (limited) return limited;
	const ctx = reportCtx(m, params.reportId);
	const report = await withTenant(ctx, async (tx) => {
		const r = await runReport(tx, m.access, params.reportId, filters);
		await auditEvent(tx, ctx, 'reports', null, `report.export.${r.id}`);
		return r;
	}).catch((err) => {
		if (err instanceof z.ZodError) error(400, err.issues[0].message);
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
