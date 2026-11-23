import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { announcementAdmin, deleteAnnouncement, saveAnnouncement } from '#lib/server/announcements.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm, scopesOf, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'announcement.manage');
	if (!scopesOf(m.access, 'announcement.manage').includes('all')) error(403, 'You do not have permission to do that.');
	const admin = await withTenant(userCtx(m), (tx) => announcementAdmin(tx));
	const announcement = admin.rows.find((r) => r.id === params.announcementId);
	if (!announcement) error(404, 'That announcement does not exist.');
	return { announcement, departments: admin.departments, branches: admin.branches };
};

const run =
	(step: typeof saveAnnouncement | typeof deleteAnnouncement): Actions[string] =>
	async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'announcement.manage');
		const form = formFields(await request.formData());
		try {
			await step(m, { ...form, announcementId: params.announcementId });
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
		redirect(303, `/t/${m.tenant.slug}/announcements`);
	};

export const actions: Actions = { save: run(saveAnnouncement), delete: run(deleteAnnouncement) };
