import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { addItem, removeItem, rolloverWeek, setItemStatus, workPlan } from '#lib/server/work-plans.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requirePerm(locals, 'report.weekly');
	return { plan: await withTenant(userCtx(m), (tx) => workPlan(tx, m.access, url.searchParams.get('week'))) };
};

async function run(fn: () => Promise<string>, requestId: string) {
	try {
		return { done: await fn() };
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

export const actions: Actions = {
	add: async ({ request, locals }) => {
		const m = requirePerm(locals, 'report.weekly');
		const form = formFields(await request.formData());
		return run(() => addItem(m, form).then(() => 'Item added.'), locals.requestId);
	},
	status: async ({ request, locals }) => {
		const m = requirePerm(locals, 'report.weekly');
		const form = formFields(await request.formData());
		return run(() => setItemStatus(m, form).then(() => 'Status updated.'), locals.requestId);
	},
	remove: async ({ request, locals }) => {
		const m = requirePerm(locals, 'report.weekly');
		const form = formFields(await request.formData());
		return run(() => removeItem(m, form).then(() => 'Item removed.'), locals.requestId);
	},
	rollover: async ({ request, locals }) => {
		const m = requirePerm(locals, 'report.weekly');
		const form = formFields(await request.formData());
		return run(
			() =>
				rolloverWeek(m, form).then((r) =>
					r.count ? `${r.count} unfinished item(s) carried to the week of ${r.next}.` : 'Nothing left to carry over.'
				),
			locals.requestId
		);
	}
};
