import { auditEvent } from '#lib/server/audit.ts';
import { config } from '#lib/server/config.ts';
import { toCsv } from '#lib/server/csv.ts';
import { exportEmployees } from '#lib/server/employees.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { hit } from '#lib/server/ratelimit.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	const m = requirePerm(locals, 'employee.read');
	const limit = await hit('download', m.user.userId, config().RL_DOWNLOADS_PER_USER_MIN, 60_000).catch(() => null);
	if (limit && !limit.ok)
		return new Response('Too many downloads', { status: 429, headers: { 'retry-after': String(limit.retryAfter) } });
	const ctx = userCtx(m);
	const rows = await withTenant(ctx, async (tx) => {
		await auditEvent(tx, ctx, 'employees', null, 'employee.export');
		return exportEmployees(tx, m.access, Object.fromEntries(url.searchParams));
	});
	return new Response(toCsv(rows), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.csv"`,
			'cache-control': 'private, no-store'
		}
	});
};
