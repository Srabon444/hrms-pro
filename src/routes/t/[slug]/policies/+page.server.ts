import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { acknowledgePolicy, policyList, savePolicy } from '#lib/server/policies.ts';
import { requireMember, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	if (locals.membership?.status !== 'active') error(403, 'You do not have permission to do that.');
	return withTenant(userCtx(m), (tx) => policyList(tx, m.access));
};

const failWith = (err: unknown, requestId: string, values: Record<string, string>) => {
	if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values });
	const failed = actionError(err, requestId);
	return fail(failed.status, { ...failed.data, values });
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const m = requirePerm(locals, 'policy.manage');
		const data = await request.formData();
		const file = data.get('file');
		const form = formFields(data);
		try {
			const saved = await savePolicy(m, { ...form, policyId: '' }, file instanceof File ? file : null);
			await sendAll(saved.mails);
		} catch (err) {
			return failWith(err, locals.requestId, form);
		}
		redirect(303, `/t/${m.tenant.slug}/policies`);
	},
	acknowledge: async ({ request, locals }) => {
		const m = requireMember(locals);
		const form = formFields(await request.formData());
		try {
			await acknowledgePolicy(m, form);
		} catch (err) {
			return failWith(err, locals.requestId, {});
		}
		return { acknowledged: true };
	}
};
