import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { addDays } from '#lib/server/dates.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { ownBalances } from '#lib/server/leave.ts';
import { cancelLeave, myLeave, requestLeave, whoIsOut } from '#lib/server/leave-requests.ts';
import { tenantToday } from '#lib/server/lifecycle.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'leave.request');
	return withTenant(userCtx(m), async (tx) => {
		const today = await tenantToday(tx);
		const { fy, rows } = await ownBalances(tx, m.access);
		return {
			today,
			fy,
			balances: rows,
			requests: await myLeave(tx, m.access),
			out: await whoIsOut(tx, m.access, today, addDays(today, 30))
		};
	});
};

export const actions: Actions = {
	request: async ({ request, locals }) => {
		const m = requirePerm(locals, 'leave.request');
		try {
			await requestLeave(m, formFields(await request.formData()));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { requested: true };
	},
	cancel: async ({ request, locals }) => {
		const m = requirePerm(locals, 'leave.request');
		try {
			await cancelLeave(m, field(await request.formData(), 'id'));
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { cancelled: true };
	}
};
