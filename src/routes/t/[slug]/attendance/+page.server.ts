import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { cancelAttendanceRequest, myAttendanceRequests, requestAttendance } from '#lib/server/attendance-requests.ts';
import { addManualPunch, attendanceMonth, punch, teamDay, todayPunches } from '#lib/server/attendance.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { tenantToday } from '#lib/server/lifecycle.ts';
import { can, requirePerm, scopesOf, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requirePerm(locals, 'attendance.read');
	return withTenant(userCtx(m), async (tx) => {
		const today = await tenantToday(tx);
		const picked = url.searchParams.get('date') ?? '';
		const date = z.iso.date().safeParse(picked).success && picked <= today ? picked : today;
		const seesTeam = scopesOf(m.access, 'attendance.read').some((s) => s !== 'own');
		return {
			today,
			date,
			canPunch: can(m.access, 'attendance.punch') && !!m.access.employeeId,
			canManage: can(m.access, 'attendance.manage'),
			now: await todayPunches(tx, m.access),
			month: m.access.employeeId
				? await attendanceMonth(tx, m.access, m.access.employeeId, url.searchParams.get('month') ?? undefined)
				: null,
			team: seesTeam ? await teamDay(tx, m.access, date) : null,
			requests: await myAttendanceRequests(tx, m.access)
		};
	});
};

export const actions: Actions = {
	punch: async ({ locals, getClientAddress }) => {
		const m = requirePerm(locals, 'attendance.punch');
		try {
			await punch(m, getClientAddress());
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { punched: true };
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
	cancelRequest: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.read');
		try {
			await cancelAttendanceRequest(m, field(await request.formData(), 'requestId'));
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { cancelledRequest: true };
	}
};
