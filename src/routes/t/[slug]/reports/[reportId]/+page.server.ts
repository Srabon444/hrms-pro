import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { AppError } from '#lib/server/errors.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { departmentOptions, reportDef, runReport } from '#lib/server/reports/index.ts';
import { shareRecipients, shareReport } from '#lib/server/reports/shares.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

const known = (access: App.Locals['access'] & object, id: string) => {
	try {
		return reportDef(access, id);
	} catch {
		error(404, 'That report does not exist.');
	}
};

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const m = requireMember(locals);
	const def = known(m.access, params.reportId);
	const filters = Object.fromEntries(url.searchParams);
	return withTenant(userCtx(m), async (tx) => {
		const departments = await departmentOptions(tx);
		const recipients = await shareRecipients(tx, m.access, def);
		try {
			const report = await runReport(tx, m.access, def.id, filters);
			return { departments, filters, recipients, report, message: null };
		} catch (err) {
			const message =
				err instanceof z.ZodError
					? err.issues[0].message
					: err instanceof AppError && err.status === 400
						? err.message
						: null;
			if (message) return { departments, filters, recipients, report: null, message };
			if (err instanceof AppError) error(err.status, err.message);
			throw err;
		}
	});
};

export const actions: Actions = {
	share: async ({ locals, params, request }) => {
		const m = requireMember(locals);
		known(m.access, params.reportId);
		const form = await request.formData();
		const text = (k: string) => String(form.get(k) ?? '');
		const all = (k: string) => form.getAll(k).map(String);
		let id: string;
		try {
			const shared = await shareReport(m, params.reportId, {
				filters: { from: text('from'), to: text('to'), department: text('department') },
				sections: all('sections'),
				columns: all('columns'),
				employees: all('employees'),
				recipients: all('recipients')
			});
			await sendAll(shared.mails);
			id = shared.id;
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		redirect(303, `/t/${m.tenant.slug}/reports/shared/${id}`);
	}
};
