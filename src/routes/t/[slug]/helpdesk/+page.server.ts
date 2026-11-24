import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { categoryOptions, createTicket, ticketList } from '#lib/server/helpdesk.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { can, requireMember, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requireMember(locals);
	const canRaise = can(m.access, 'helpdesk.submit') && !!m.access.employeeId;
	return withTenant(userCtx(m), async (tx) => ({
		list: await ticketList(tx, m.access, url.searchParams.get('filter')),
		categories: canRaise ? await categoryOptions(tx) : [],
		canRaise
	}));
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const m = requirePerm(locals, 'helpdesk.submit');
		const form = formFields(await request.formData());
		let id: string;
		try {
			const created = await createTicket(m, form);
			await sendAll(created.mails);
			id = created.id;
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
		redirect(303, `/t/${m.tenant.slug}/helpdesk/${id}`);
	}
};
