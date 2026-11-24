import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { createCycle, performanceHome } from '#lib/server/performance.ts';
import { requirePerm, scopesOf, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'performance.read');
	return {
		home: await withTenant(userCtx(m), (tx) => performanceHome(tx, m.access)),
		canRun: scopesOf(m.access, 'performance.manage').includes('all')
	};
};

export const actions: Actions = {
	cycle: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'performance.manage');
		const form = formFields(await request.formData());
		let id: string;
		try {
			const created = await createCycle(m, form);
			await sendAll(created.mails);
			id = created.cycleId;
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
		redirect(303, `/t/${params.slug}/performance/${id}`);
	}
};
