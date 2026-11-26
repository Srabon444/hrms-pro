import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { actionError } from '#lib/server/http/forms.ts';
import { modulesOn, saveModules } from '#lib/server/modules.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'settings.manage');
	return { on: [...(await withTenant(userCtx(m), modulesOn))] };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		try {
			await saveModules(userCtx(m), (await request.formData()).getAll('modules').map(String));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: 'Pick modules from the list.' });
			return actionError(err, locals.requestId);
		}
		return { saved: true };
	}
};
