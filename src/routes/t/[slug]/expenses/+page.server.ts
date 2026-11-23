import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { cancelClaim, decideClaim, expenseBoard, payClaim, saveCategory, submitClaim } from '#lib/server/expenses.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { can, requireMember, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { MAX_EXPENSE_ITEMS } from '#lib/server/db/schema/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	if (!(['expense.submit', 'expense.approve', 'expense.pay'] as const).some((p) => can(m.access, p)))
		error(403, 'You do not have permission to do that.');
	return { board: await withTenant(userCtx(m), (tx) => expenseBoard(tx, m)), maxItems: MAX_EXPENSE_ITEMS };
};

async function run(fn: () => Promise<unknown>, requestId: string, done: string) {
	try {
		const mails = await fn();
		if (Array.isArray(mails)) await sendAll(mails);
		return { done };
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

export const actions: Actions = {
	submit: async ({ request, locals }) => {
		const m = requirePerm(locals, 'expense.submit');
		const data = await request.formData();
		const files = new Map<number, File>();
		for (const [key, value] of data.entries()) {
			const match = /^items\.(\d+)\.receipt$/.exec(key);
			if (match && value instanceof File && value.size) files.set(Number(match[1]), value);
		}
		return run(() => submitClaim(m, formFields(data), files), locals.requestId, 'Expense claim sent for approval.');
	},
	cancel: async ({ request, locals }) => {
		const m = requirePerm(locals, 'expense.submit');
		const form = formFields(await request.formData());
		return run(() => cancelClaim(m, form), locals.requestId, 'Expense claim cancelled.');
	},
	decide: async ({ request, locals }) => {
		const m = requirePerm(locals, 'expense.approve');
		const form = formFields(await request.formData());
		return run(
			() => decideClaim(m, form),
			locals.requestId,
			form.decision === 'approve' ? 'Expense claim approved.' : 'Expense claim rejected.'
		);
	},
	pay: async ({ request, locals }) => {
		const m = requirePerm(locals, 'expense.pay');
		const form = formFields(await request.formData());
		return run(() => payClaim(m, form), locals.requestId, 'Expense claim marked paid.');
	},
	category: async ({ request, locals }) => {
		const m = requirePerm(locals, 'expense.pay');
		const form = formFields(await request.formData());
		return run(() => saveCategory(m, form.id ?? '', form), locals.requestId, 'Category saved.');
	}
};
