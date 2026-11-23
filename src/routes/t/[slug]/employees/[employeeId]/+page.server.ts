import { error } from '@sveltejs/kit';
import { employeeChoices, getEmployee, updateEmployee } from '#lib/server/employees.ts';
import { employeeActionError, formFields } from '#lib/server/http/employee-form.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'employee.read');
	return withTenant(userCtx(m), async (tx) => {
		const record = await getEmployee(tx, m.access, params.employeeId);
		if (!record) error(404, 'Not found');
		return { ...record, choices: record.canUpdate ? await employeeChoices(tx) : null };
	});
};

export const actions: Actions = {
	default: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'employee.update');
		const values = formFields(await request.formData());
		try {
			await updateEmployee(userCtx(m), m.access, params.employeeId, values);
		} catch (err) {
			return employeeActionError(err, locals.requestId, values);
		}
		return { saved: true };
	}
};
