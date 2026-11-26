import { deleteEvent, eventsPage, rsvpEvent, saveEvent } from '#lib/server/events.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'events', 'calendar.read');
	return withTenant(userCtx(m), (tx) => eventsPage(tx, m.access));
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const m = await requireModule(locals, 'events', 'event.manage');
		const form = formFields(await request.formData());
		try {
			await saveEvent(m, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { saved: true };
	},
	delete: async ({ request, locals }) => {
		const m = await requireModule(locals, 'events', 'event.manage');
		try {
			await deleteEvent(m, formFields(await request.formData()));
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		return { deleted: true };
	},
	rsvp: async ({ request, locals }) => {
		const m = await requireModule(locals, 'events', 'calendar.read');
		try {
			await rsvpEvent(m, formFields(await request.formData()));
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		return { answered: true };
	}
};
