import { error, redirect } from '@sveltejs/kit';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireModule } from '#lib/server/modules.ts';
import { oneOnOnesHome, scheduleOneOnOne } from '#lib/server/one-on-ones.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'one_on_ones', 'performance.read');
	if (locals.membership?.status !== 'active') error(403, 'You do not have permission to do that.');
	return withTenant(userCtx(m), (tx) => oneOnOnesHome(tx, m.access));
};

export const actions: Actions = {
	schedule: async ({ request, locals }) => {
		const m = await requireModule(locals, 'one_on_ones', 'performance.read');
		const form = formFields(await request.formData());
		let id: string;
		try {
			id = await scheduleOneOnOne(m, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		redirect(303, `/t/${m.tenant.slug}/one-on-ones/${id}`);
	}
};
