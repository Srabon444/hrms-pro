import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { upcomingExits } from '#lib/server/exits.ts';
import { decideProbation, probationDue } from '#lib/server/lifecycle.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'employee.update');
	return withTenant(userCtx(m), async (tx) => ({
		probation: await probationDue(tx, m.access),
		exits: await upcomingExits(tx, m.access)
	}));
};

export const actions: Actions = {
	probation: async ({ request, locals }) => {
		const m = requirePerm(locals, 'employee.update');
		const form = await request.formData();
		try {
			await decideProbation(m, field(form, 'employeeId'), formFields(form));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { probationSaved: field(form, 'decision') };
	}
};
