import { redirect } from '@sveltejs/kit';
import { createEmployee, employeeChoices } from '#lib/server/employees.ts';
import { employeeActionError, formFields } from '#lib/server/http/employee-form.ts';
import { can, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'employee.create');
	return {
		choices: await withTenant(userCtx(m), employeeChoices),
		sensitive: can(m.access, 'employee.sensitive.update')
	};
};

export const actions: Actions = {
	default: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'employee.create');
		const values = formFields(await request.formData());
		let id: string;
		try {
			id = await createEmployee(userCtx(m), m.access, values);
		} catch (err) {
			return employeeActionError(err, locals.requestId, values);
		}
		redirect(303, `/t/${params.slug}/employees/${id}`);
	}
};
