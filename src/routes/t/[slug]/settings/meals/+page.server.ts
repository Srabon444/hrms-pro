import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { mealSetup, saveMealSettings, saveMealType, saveVendor, setMealPrice } from '#lib/server/meals.ts';
import { can, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'meal.manage');
	return { setup: await withTenant(userCtx(m), mealSetup), canBill: can(m.access, 'meal.billing') };
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
	settings: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.manage');
		const form = formFields(await request.formData());
		return run(() => saveMealSettings(userCtx(m), can(m.access, 'meal.billing'), form), locals.requestId);
	},
	vendor: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.manage');
		const form = await request.formData();
		return run(() => saveVendor(userCtx(m), field(form, 'vendorId'), formFields(form)), locals.requestId);
	},
	type: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.manage');
		const form = await request.formData();
		return run(() => saveMealType(userCtx(m), field(form, 'typeId'), formFields(form)), locals.requestId);
	},
	price: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.manage');
		const form = formFields(await request.formData());
		return run(() => setMealPrice(userCtx(m), form), locals.requestId);
	}
};
