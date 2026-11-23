import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { LEAVE_ACCRUALS, LEAVE_GENDERS } from '#lib/server/db/schema/leave.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { createLeaveType, listLeaveTypes, updateLeaveType } from '#lib/server/leave-types.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'leave.manage');
	return { types: await withTenant(userCtx(m), listLeaveTypes), accruals: LEAVE_ACCRUALS, genders: LEAVE_GENDERS };
};

async function run(fn: () => Promise<unknown>, requestId: string) {
	try {
		await fn();
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
	return { saved: true };
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const m = requirePerm(locals, 'leave.manage');
		const form = formFields(await request.formData());
		return run(() => createLeaveType(userCtx(m), form), locals.requestId);
	},
	update: async ({ request, locals }) => {
		const m = requirePerm(locals, 'leave.manage');
		const form = await request.formData();
		return run(() => updateLeaveType(userCtx(m), field(form, 'typeId'), formFields(form)), locals.requestId);
	}
};
