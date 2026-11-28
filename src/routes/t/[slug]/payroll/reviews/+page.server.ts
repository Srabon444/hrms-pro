import { createCycle, cyclesPage } from '#lib/server/comp.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => cyclesPage(requireMember(locals));

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const m = requireMember(locals);
		const form = formFields(await request.formData());
		let id: string;
		try {
			id = await createCycle(m, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		redirect(303, `/t/${m.tenant.slug}/payroll/reviews/${id}`);
	}
};
