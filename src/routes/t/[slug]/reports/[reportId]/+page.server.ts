import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { AppError } from '#lib/server/errors.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { departmentOptions, reportDef, runReport } from '#lib/server/reports/index.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const m = requireMember(locals);
	try {
		reportDef(m.access, params.reportId);
	} catch {
		error(404, 'That report does not exist.');
	}
	const filters = Object.fromEntries(url.searchParams);
	return withTenant(userCtx(m), async (tx) => {
		const departments = await departmentOptions(tx);
		try {
			return { departments, filters, report: await runReport(tx, m.access, params.reportId, filters), message: null };
		} catch (err) {
			if (err instanceof z.ZodError) return { departments, filters, report: null, message: err.issues[0].message };
			if (err instanceof AppError && err.status === 400)
				return { departments, filters, report: null, message: err.message };
			if (err instanceof AppError) error(err.status, err.message);
			throw err;
		}
	});
};
