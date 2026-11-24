import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { commentOnTicket, requesterAction, ticketView, updateTicket } from '#lib/server/helpdesk.ts';
import { listFiles } from '#lib/server/attachments.ts';
import { attachmentAction, pickFiles } from '#lib/server/http/attachments.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import type { Mail } from '#lib/server/mail.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requireMember(locals);
	const { view, attachments } = await withTenant(userCtx(m), async (tx) => ({
		view: await ticketView(tx, m.access, params.ticketId),
		attachments: await listFiles(tx, m.access, 'ticket', params.ticketId)
	}));
	if (!view) error(404, 'That ticket does not exist.');
	return { view, attachments };
};

const act =
	(
		step: (m: ReturnType<typeof requireMember>, raw: Record<string, string>, files: File[]) => Promise<Mail[]>,
		done: string
	): Actions[string] =>
	async ({ request, locals, params }) => {
		const m = requireMember(locals);
		const data = await request.formData();
		const form = formFields(data);
		try {
			await sendAll(await step(m, { ...form, ticketId: params.ticketId }, pickFiles(data)));
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
	requester: act(requesterAction, 'Ticket updated.'),
	files: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		return attachmentAction(m, await request.formData(), 'ticket', params.ticketId, locals.requestId);
	}
};
