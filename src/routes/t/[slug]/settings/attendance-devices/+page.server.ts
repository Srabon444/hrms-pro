import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { API_REAUTH_MINUTES } from '#lib/server/api-keys.ts';
import {
	clearReview,
	createDevice,
	listDevices,
	listDeviceUsers,
	listReview,
	manager,
	revokeDevice,
	rotateDeviceKey,
	setDeviceUserId
} from '#lib/server/attendance-devices.ts';
import { confirmRecentAuth } from '#lib/server/auth/service.ts';
import { recentlyAuthed } from '#lib/server/auth/session.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { kioskSites } from '#lib/server/kiosk.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'attendance.manage');
	manager(m);
	return {
		...(await withTenant(userCtx(m), async (tx) => ({
			devices: await listDevices(tx),
			users: await listDeviceUsers(tx),
			review: await listReview(tx),
			sites: await kioskSites(tx)
		}))),
		recent: await recentlyAuthed(m.user.sessionId, API_REAUTH_MINUTES),
		totp: m.user.totpEnabled
	};
};

async function run<T>(fn: () => Promise<T>, requestId: string) {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

export const actions: Actions = {
	reauth: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.manage');
		const form = await request.formData();
		return run(async () => {
			await confirmRecentAuth(m.user, field(form, 'password'), field(form, 'code'));
			return { done: `Confirmed. You can add devices for the next ${API_REAUTH_MINUTES} minutes.` };
		}, locals.requestId);
	},
	create: async ({ request, locals, setHeaders }) => {
		const m = requirePerm(locals, 'attendance.manage');
		setHeaders({ 'cache-control': 'no-store' });
		const form = await request.formData();
		return run(async () => ({ key: await createDevice(m, formFields(form)) }), locals.requestId);
	},
	rotate: async ({ request, locals, setHeaders }) => {
		const m = requirePerm(locals, 'attendance.manage');
		setHeaders({ 'cache-control': 'no-store' });
		const form = await request.formData();
		return run(async () => ({ key: await rotateDeviceKey(m, field(form, 'deviceId')) }), locals.requestId);
	},
	revoke: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.manage');
		const form = await request.formData();
		return run(async () => {
			await revokeDevice(m, field(form, 'deviceId'));
			return { done: 'Device switched off. Its key stops working now.' };
		}, locals.requestId);
	},
	user: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.manage');
		const form = await request.formData();
		return run(async () => {
			const name = await setDeviceUserId(m, formFields(form));
			return { done: `Saved the device user ID for ${name}.` };
		}, locals.requestId);
	},
	review: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.manage');
		const form = await request.formData();
		return run(async () => {
			const n = await clearReview(m, form.getAll('punchId').map(String));
			return { done: `${n} ${n === 1 ? 'punch' : 'punches'} marked as checked.` };
		}, locals.requestId);
	}
};
