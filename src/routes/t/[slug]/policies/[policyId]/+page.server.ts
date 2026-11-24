import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { policyReport, savePolicy } from '#lib/server/policies.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'policy.manage');
	const report = await withTenant(userCtx(m), (tx) => policyReport(tx, m.access, params.policyId));
	if (!report) error(404, 'That policy does not exist.');
	return report;
};

export const actions: Actions = {
	save: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'policy.manage');
		const data = await request.formData();
		const file = data.get('file');
		const form = formFields(data);
		try {
			const saved = await savePolicy(m, { ...form, policyId: params.policyId }, file instanceof File ? file : null);
			await sendAll(saved.mails);
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
		redirect(303, `/t/${m.tenant.slug}/policies/${params.policyId}`);
	}
};
