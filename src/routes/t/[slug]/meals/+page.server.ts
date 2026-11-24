import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { tenantToday } from '#lib/server/lifecycle.ts';
import { mealDue, myBills } from '#lib/server/meal-bills.ts';
import {
	adjustMeal,
	chooseMeal,
	lockMealDay,
	mealDay,
	myMeals,
	prepareDayNow,
	skipMeals
} from '#lib/server/meal-orders.ts';
import { can, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requirePerm(locals, 'meal.order');
	return withTenant(userCtx(m), async (tx) => {
		const canManage = can(m.access, 'meal.manage');
		const picked = url.searchParams.get('date') ?? '';
		const date = z.iso.date().safeParse(picked).success ? picked : await tenantToday(tx);
		return {
			mine: await myMeals(tx, m.access),
			bills: await myBills(tx, m.access),
			due: await mealDue(tx, m.access),
			day: canManage ? await mealDay(tx, m.access, date) : null
		};
	});
};

async function run(fn: () => Promise<unknown>, requestId: string, done = 'Meal saved.') {
	try {
		const result = await fn();
		return { done: typeof result === 'number' ? `Meals skipped on ${result} days.` : done };
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

export const actions: Actions = {
	choose: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.order');
		const form = formFields(await request.formData());
		return run(() => chooseMeal(m, form), locals.requestId);
	},
	skip: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.order');
		const form = formFields(await request.formData());
		return run(() => skipMeals(m, form), locals.requestId);
	},
	prepare: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.manage');
		const form = await request.formData();
		return run(() => prepareDayNow(m, field(form, 'date')), locals.requestId, 'Day prepared.');
	},
	adjust: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.manage');
		const form = formFields(await request.formData());
		return run(() => adjustMeal(m, form), locals.requestId, 'Meal corrected.');
	},
	lock: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.manage');
		const form = await request.formData();
		return run(() => lockMealDay(m, field(form, 'date'), true), locals.requestId, 'Day locked.');
	},
	unlock: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.manage');
		const form = await request.formData();
		return run(() => lockMealDay(m, field(form, 'date'), false), locals.requestId, 'Day unlocked.');
	}
};
