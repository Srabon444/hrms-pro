import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { filesFor } from '#lib/server/attachments.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requireMember, requirePerm } from '#lib/server/rbac/access.ts';
import { decideSalary, proposeSalary, salaryBoard, salaryCtx } from '#lib/server/salaries.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'salary.read');
	return withTenant(salaryCtx(m), async (tx) => {
		const board = await salaryBoard(tx, m);
		const ids = board.pending.map((c) => c.id);
		return { board, changeFiles: Object.fromEntries(await filesFor(tx, 'salary_change', ids)) };
	});
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
	changeFiles: async ({ request, locals }) => {
		const m = requireMember(locals);
		const form = await request.formData();
		return attachmentAction(m, form, 'salary_change', field(form, 'ownerId'), locals.requestId);
	},
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
