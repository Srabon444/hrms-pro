import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import {
	approveRun,
	canSeePayroll,
	payrollBoard,
	payRun,
	recomputeRun,
	reopenRun,
	startRun,
	voidRun
} from '#lib/server/payroll.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requireMember(locals);
	if (!canSeePayroll(m.access)) error(403, 'You do not have permission to do that.');
	return { board: await payrollBoard(m, url.searchParams.get('run') ?? undefined) };
};

const action =
	(fn: (m: ReturnType<typeof requireMember>, form: Record<string, string>) => Promise<unknown>, done: string) =>
	async ({ request, locals }: { request: Request; locals: App.Locals }) => {
		const m = requireMember(locals);
		const form = formFields(await request.formData());
		try {
			await fn(m, form);
			return { done };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
	};

export const actions: Actions = {
	start: action(startRun, 'Payroll computed. Review it and send it for approval.'),
	recompute: action(recomputeRun, 'Payroll recomputed.'),
	void: action(voidRun, 'Payroll run voided.'),
	approve: action(approveRun, 'Payroll approved.'),
	reopen: action(reopenRun, 'Payroll reopened.'),
	pay: action(payRun, 'Payroll marked paid.')
};
