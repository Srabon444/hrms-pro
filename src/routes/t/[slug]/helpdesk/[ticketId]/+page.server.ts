import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { commentOnTicket, requesterAction, ticketView, updateTicket } from '#lib/server/helpdesk.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import type { Mail } from '#lib/server/mail.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requireMember(locals);
	const view = await withTenant(userCtx(m), (tx) => ticketView(tx, m.access, params.ticketId));
	if (!view) error(404, 'That ticket does not exist.');
	return { view };
};

const act =
	(
		step: (m: ReturnType<typeof requireMember>, raw: Record<string, string>) => Promise<Mail[]>,
		done: string
	): Actions[string] =>
	async ({ request, locals, params }) => {
		const m = requireMember(locals);
		const form = formFields(await request.formData());
		try {
			await sendAll(await step(m, { ...form, ticketId: params.ticketId }));
			return { done };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
	};

export const actions: Actions = {
	update: act(updateTicket, 'Ticket updated.'),
	comment: act(commentOnTicket, 'Comment added.'),
	requester: act(requesterAction, 'Ticket updated.')
};
