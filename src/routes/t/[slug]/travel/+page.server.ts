import { error } from '@sveltejs/kit';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireModule } from '#lib/server/modules.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { can, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { cancelTrip, decideTrip, deleteRate, requestTrip, saveRate, travelBoard } from '#lib/server/travel.ts';
import type { Permission } from '#lib/rbac/permissions.ts';
import type { Actions, PageServerLoad } from './$types';

const ANY: Permission[] = ['travel.request', 'travel.approve', 'travel.manage', 'travel.read'];

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'travel');
	if (!ANY.some((p) => can(m.access, p))) error(403, 'You do not have permission to do that.');
	return { board: await withTenant(userCtx(m), (tx) => travelBoard(tx, m)) };
};

async function run(fn: () => Promise<unknown>, requestId: string, form: Record<string, string>, done: string) {
	try {
		const mails = await fn();
		if (Array.isArray(mails)) await sendAll(mails);
		return { done };
	} catch (err) {
		return failed(err, requestId, form);
	}
}

export const actions: Actions = {
	request: async ({ request, locals }) => {
		const m = await requireModule(locals, 'travel', 'travel.request');
		const form = formFields(await request.formData());
		return run(() => requestTrip(m, form), locals.requestId, form, 'Trip sent for approval.');
	},
	cancel: async ({ request, locals }) => {
		const m = await requireModule(locals, 'travel');
		const form = formFields(await request.formData());
		return run(() => cancelTrip(m, form), locals.requestId, form, 'Trip cancelled.');
	},
	decide: async ({ request, locals }) => {
		const m = await requireModule(locals, 'travel');
		const form = formFields(await request.formData());
		return run(
			() => decideTrip(m, form),
			locals.requestId,
			form,
			form.decision === 'approve' ? 'Trip approved.' : 'Trip rejected.'
		);
	},
	rate: async ({ request, locals }) => {
		const m = await requireModule(locals, 'travel', 'travel.manage');
		const form = formFields(await request.formData());
		return run(() => saveRate(m, form), locals.requestId, form, 'Per diem rate saved.');
	},
	removeRate: async ({ request, locals }) => {
		const m = await requireModule(locals, 'travel', 'travel.manage');
		const form = formFields(await request.formData());
		return run(() => deleteRate(m, form), locals.requestId, form, 'Per diem rate removed.');
	}
};
