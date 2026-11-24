import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { filesFor } from '#lib/server/attachments.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { cancelLoan, decideLoan, loanBoard, requestLoan } from '#lib/server/loans.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { can, requireMember, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	if (!can(m.access, 'loan.request') && !can(m.access, 'loan.approve'))
		error(403, 'You do not have permission to do that.');
	return withTenant(userCtx(m), async (tx) => {
		const board = await loanBoard(tx, m);
		const ids = [...board.mine, ...board.toDecide].map((l) => l.id);
		return { board, loanFiles: Object.fromEntries(await filesFor(tx, 'loan', ids)) };
	});
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
	loanFiles: async ({ request, locals }) => {
		const m = requireMember(locals);
		const form = await request.formData();
		return attachmentAction(m, form, 'loan', field(form, 'ownerId'), locals.requestId);
	},
	request: async ({ request, locals }) => {
		const m = requirePerm(locals, 'loan.request');
		const form = formFields(await request.formData());
		return run(() => requestLoan(m, form), locals.requestId, 'Request sent for approval.');
	},
	cancel: async ({ request, locals }) => {
		const m = requirePerm(locals, 'loan.request');
		const form = formFields(await request.formData());
		return run(() => cancelLoan(m, form), locals.requestId, 'Request cancelled.');
	},
	decide: async ({ request, locals }) => {
		const m = requirePerm(locals, 'loan.approve');
		const form = formFields(await request.formData());
		return run(
			() => decideLoan(m, form),
			locals.requestId,
			form.decision === 'approve' ? 'Request approved.' : 'Request rejected.'
		);
	}
};
