import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { createShift, listShifts, updateShift } from '#lib/server/shifts.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'attendance.manage');
	return { shifts: await withTenant(userCtx(m), listShifts) };
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
		const m = requirePerm(locals, 'attendance.manage');
		const form = formFields(await request.formData());
		return run(() => createShift(userCtx(m), form), locals.requestId);
	},
	update: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.manage');
		const form = await request.formData();
		return run(() => updateShift(userCtx(m), field(form, 'shiftId'), formFields(form)), locals.requestId);
	}
};
