import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import { decideSalary, proposeSalary, salaryBoard, salaryCtx } from '#lib/server/salaries.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'salary.read');
	return { board: await withTenant(salaryCtx(m), (tx) => salaryBoard(tx, m)) };
};

async function run(fn: () => Promise<unknown>, requestId: string, done: (r: unknown) => string) {
	try {
		return { done: done(await fn()) };
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

export const actions: Actions = {
	propose: async ({ request, locals }) => {
		const m = requirePerm(locals, 'salary.update');
		const form = formFields(await request.formData());
		return run(
			() => proposeSalary(m, form),
			locals.requestId,
			() => 'Salary change sent for approval.'
		);
	},
	decide: async ({ request, locals }) => {
		const m = requirePerm(locals, 'salary.approve');
		const form = formFields(await request.formData());
		return run(
			() => decideSalary(m, form),
			locals.requestId,
			(r) => (r === 'approved' ? 'Salary change approved.' : 'Salary change rejected.')
		);
	}
};
