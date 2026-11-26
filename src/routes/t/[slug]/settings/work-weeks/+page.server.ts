import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { createWorkWeek, listWorkWeeks, updateWorkWeek } from '#lib/server/work-weeks.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'attendance.manage');
	return { weeks: await withTenant(userCtx(m), listWorkWeeks) };
};

const weekForm = (form: FormData) => ({
	name: field(form, 'name'),
	weekendDays: form.getAll('weekendDays').map(String),
	active: field(form, 'active')
});

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
		const form = await request.formData();
		return run(() => createWorkWeek(userCtx(m), weekForm(form)), locals.requestId);
	},
	update: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.manage');
		const form = await request.formData();
		return run(() => updateWorkWeek(userCtx(m), field(form, 'workWeekId'), weekForm(form)), locals.requestId);
	}
};
