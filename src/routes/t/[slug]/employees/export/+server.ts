import { auditEvent } from '#lib/server/audit.ts';
import { error } from '@sveltejs/kit';
import { MAX_EXPORT_ROWS, toCsv, tooManyToExport } from '#lib/server/csv.ts';
import { exportEmployees } from '#lib/server/employees.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { downloadLimit } from '#lib/server/ratelimit.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	const m = requirePerm(locals, 'employee.read');
	const limited = await downloadLimit(m.user.userId);
	if (limited) return limited;
	const ctx = userCtx(m);
	const rows = await withTenant(ctx, async (tx) => {
		const list = await exportEmployees(tx, m.access, Object.fromEntries(url.searchParams));
		if (tooManyToExport(list)) error(413, `A file can hold at most ${MAX_EXPORT_ROWS} rows. Narrow the filters.`);
		await auditEvent(tx, ctx, 'employees', null, 'employee.export');
		return list;
	});
	return new Response(toCsv(rows), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.csv"`,
			'cache-control': 'private, no-store'
		}
	});
};
