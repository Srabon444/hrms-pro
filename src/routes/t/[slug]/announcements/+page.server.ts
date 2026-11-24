import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import {
	announcementAdmin,
	announcementFeed,
	canRunAnnouncements,
	saveAnnouncement
} from '#lib/server/announcements.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requireMember, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	if (locals.membership?.status !== 'active') error(403, 'You do not have permission to do that.');
	const canManage = canRunAnnouncements(m.access);
	return withTenant(userCtx(m), async (tx) => ({
		feed: await announcementFeed(tx, m.access),
		admin: canManage ? await announcementAdmin(tx) : null
	}));
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const m = requirePerm(locals, 'announcement.manage');
		const form = formFields(await request.formData());
		try {
			await saveAnnouncement(m, { ...form, announcementId: '' });
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
		redirect(303, `/t/${m.tenant.slug}/announcements`);
	}
};
