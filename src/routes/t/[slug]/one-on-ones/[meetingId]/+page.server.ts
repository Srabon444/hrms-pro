import { error } from '@sveltejs/kit';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireModule } from '#lib/server/modules.ts';
import {
	addItem,
	meetingPage,
	removeItem,
	savePrivateNote,
	setMeetingStatus,
	toggleAction
} from '#lib/server/one-on-ones.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = await requireModule(locals, 'one_on_ones', 'performance.read');
	if (locals.membership?.status !== 'active') error(403, 'You do not have permission to do that.');
	const page = await withTenant(userCtx(m), (tx) => meetingPage(tx, m.access, params.meetingId));
	if (!page) error(404, 'That 1:1 does not exist.');
	return page;
};

type Member = Awaited<ReturnType<typeof requireModule>>;

const run =
	(step: (m: Member, id: string, form: Record<string, string>) => Promise<unknown>, done: string): Actions[string] =>
	async ({ request, locals, params }) => {
		const m = await requireModule(locals, 'one_on_ones', 'performance.read');
		const form = formFields(await request.formData());
		try {
			await step(m, params.meetingId, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done };
	};

export const actions: Actions = {
	item: run((m, id, form) => addItem(m, id, form), 'Item added.'),
	toggle: run((m, _id, form) => toggleAction(m, form.itemId ?? ''), 'Action updated.'),
	remove: run((m, _id, form) => removeItem(m, form.itemId ?? ''), 'Item removed.'),
	note: run((m, id, form) => savePrivateNote(m, id, form.note ?? ''), 'Private note saved.'),
	done: run((m, id) => setMeetingStatus(m, id, 'done'), '1:1 marked done.'),
	cancel: run((m, id) => setMeetingStatus(m, id, 'cancelled'), '1:1 cancelled.')
};
