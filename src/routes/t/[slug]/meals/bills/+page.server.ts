import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { filesFor } from '#lib/server/attachments.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { tenantToday } from '#lib/server/lifecycle.ts';
import {
	generateBills,
	issueBills,
	lastPeriod,
	mealStatement,
	periodBills,
	recordPayment,
	voidBill
} from '#lib/server/meal-bills.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requirePerm(locals, 'meal.billing');
	return withTenant(userCtx(m), async (tx) => {
		const picked = url.searchParams.get('period') ?? '';
		const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(picked) ? picked : lastPeriod(await tenantToday(tx));
		const billing = await periodBills(tx, m.access, period);
		return {
			billing,
			receipts: Object.fromEntries(
				await filesFor(
					tx,
					'meal_bill',
					billing.bills.map((b) => b.id)
				)
			),
			statement: await mealStatement(tx, period),
			today: await tenantToday(tx)
		};
	});
};

async function run(fn: () => Promise<unknown>, requestId: string, done: (n: number) => string) {
	try {
		return { done: done((await fn()) as number) };
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

export const actions: Actions = {
	receipts: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.billing');
		const form = await request.formData();
		return attachmentAction(m, form, 'meal_bill', field(form, 'ownerId'), locals.requestId);
	},
	generate: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.billing');
		const form = formFields(await request.formData());
		return run(
			() => generateBills(m, form),
			locals.requestId,
			(n) => `${n} draft bills ready.`
		);
	},
	issue: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.billing');
		const form = formFields(await request.formData());
		return run(
			() => issueBills(m, form),
			locals.requestId,
			(n) => `${n} bills issued.`
		);
	},
	void: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.billing');
		const form = formFields(await request.formData());
		return run(
			() => voidBill(m, form),
			locals.requestId,
			() => 'Bill voided.'
		);
	},
	pay: async ({ request, locals }) => {
		const m = requirePerm(locals, 'meal.billing');
		const form = formFields(await request.formData());
		return run(
			() => recordPayment(m, form),
			locals.requestId,
			() => 'Payment recorded.'
		);
	}
};
