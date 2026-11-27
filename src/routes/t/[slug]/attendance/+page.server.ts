import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { filesFor } from '#lib/server/attachments.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { cancelAttendanceRequest, myAttendanceRequests, requestAttendance } from '#lib/server/attendance-requests.ts';
import {
	addManualPunch,
	attendanceMonth,
	importPunches,
	punch,
	teamDay,
	todayPunches
} from '#lib/server/attendance.ts';
import { readCsvUpload } from '#lib/server/csv.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { tenantToday } from '#lib/server/lifecycle.ts';
import { punchRule } from '#lib/server/work-sites.ts';
import { can, requireMember, requirePerm, scopesOf, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requirePerm(locals, 'attendance.read');
	return withTenant(userCtx(m), async (tx) => {
		const today = await tenantToday(tx);
		const picked = url.searchParams.get('date') ?? '';
		const date = z.iso.date().safeParse(picked).success && picked <= today ? picked : today;
		const seesTeam = scopesOf(m.access, 'attendance.read').some((s) => s !== 'own');
		const requests = await myAttendanceRequests(tx, m.access);
		return {
			today,
			date,
			canPunch: can(m.access, 'attendance.punch') && !!m.access.employeeId,
			canManage: can(m.access, 'attendance.manage'),
			locationRule: await punchRule(tx),
			now: await todayPunches(tx, m.access),
			month: m.access.employeeId
				? await attendanceMonth(tx, m.access, m.access.employeeId, url.searchParams.get('month') ?? undefined)
				: null,
			team: seesTeam ? await teamDay(tx, m.access, date) : null,
			requests,
			requestFiles: Object.fromEntries(
				await filesFor(
					tx,
					'attendance_request',
					requests.map((r) => r.id)
				)
			)
		};
	});
};

export const actions: Actions = {
	punch: async ({ request, locals, getClientAddress }) => {
		const m = requirePerm(locals, 'attendance.punch');
		try {
			const done = await punch(m, getClientAddress(), formFields(await request.formData()));
			return { punched: true, outsideSite: done.outsideSite };
		} catch (err) {
			return actionError(err, locals.requestId);
		}
	},
	manual: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.manage');
		const form = await request.formData();
		try {
			await addManualPunch(m, field(form, 'employeeId'), formFields(form));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { added: true };
	},
	request: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.punch');
		try {
			await requestAttendance(m, formFields(await request.formData()));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { requested: true };
	},
	requestFiles: async ({ request, locals }) => {
		const m = requireMember(locals);
		const form = await request.formData();
		return attachmentAction(m, form, 'attendance_request', field(form, 'ownerId'), locals.requestId);
	},
	cancelRequest: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.read');
		try {
			await cancelAttendanceRequest(m, field(await request.formData(), 'requestId'));
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { cancelledRequest: true };
	},
	importPunches: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.manage');
		try {
			const table = await readCsvUpload((await request.formData()).get('file'));
			return { imported: await importPunches(m, table) };
		} catch (err) {
			return actionError(err, locals.requestId);
		}
	}
};
