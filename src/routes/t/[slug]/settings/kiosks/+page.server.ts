import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { kioskPairLink, kioskSites, listKiosks, resetKioskPin, revokeKiosk, saveKiosk } from '#lib/server/kiosk.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'kiosk', 'attendance.manage');
	return withTenant(userCtx(m), async (tx) => ({ kiosks: await listKiosks(tx), sites: await kioskSites(tx) }));
};

async function run<T>(fn: () => Promise<T>, requestId: string) {
	try {
		return { done: await fn() };
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const m = await requireModule(locals, 'kiosk', 'attendance.manage');
		const form = await request.formData();
		return run(async () => {
			await saveKiosk(userCtx(m), field(form, 'kioskId'), formFields(form));
			return 'Kiosks saved.';
		}, locals.requestId);
	},
	pair: async ({ request, locals }) => {
		const m = await requireModule(locals, 'kiosk', 'attendance.manage');
		const form = await request.formData();
		const kioskId = field(form, 'kioskId');
		const link = await run(() => kioskPairLink(userCtx(m), kioskId), locals.requestId);
		return 'done' in link ? { link: link.done, kioskId } : link;
	},
	revoke: async ({ request, locals }) => {
		const m = await requireModule(locals, 'kiosk', 'attendance.manage');
		const form = await request.formData();
		return run(async () => {
			await revokeKiosk(userCtx(m), field(form, 'kioskId'));
			return 'Kiosk switched off. Make a new pairing link to use it again.';
		}, locals.requestId);
	},
	resetPin: async ({ request, locals }) => {
		const m = await requireModule(locals, 'kiosk', 'attendance.manage');
		const form = await request.formData();
		return run(
			async () =>
				`${await resetKioskPin(m, field(form, 'code'))} can now set a new kiosk PIN from their attendance page.`,
			locals.requestId
		);
	}
};
