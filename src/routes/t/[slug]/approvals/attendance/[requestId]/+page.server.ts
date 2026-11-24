import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { listFiles } from '#lib/server/attachments.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { cancelAttendanceRequest, decideAttendance, getAttendanceRequest } from '#lib/server/attendance-requests.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requireMember(locals);
	const { req, attachments } = await withTenant(userCtx(m), async (tx) => ({
		req: await getAttendanceRequest(tx, m.access, params.requestId),
		attachments: await listFiles(tx, m.access, 'attendance_request', params.requestId)
	}));
	if (!req) error(404, 'Not found');
	return { req, attachments };
};

export const actions: Actions = {
	files: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		return attachmentAction(m, await request.formData(), 'attendance_request', params.requestId, locals.requestId);
	},
	decide: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		try {
			await decideAttendance(m, params.requestId, formFields(await request.formData()));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { decided: true };
	},
	cancel: async ({ locals, params }) => {
		const m = requireMember(locals);
		try {
			await cancelAttendanceRequest(m, params.requestId);
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { cancelled: true };
	}
};
