import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { assetList, canRunAssets, saveAsset } from '#lib/server/assets.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requirePerm(locals, 'asset.read');
	const filter = { q: url.searchParams.get('q'), status: url.searchParams.get('status') };
	return {
		assets: await withTenant(userCtx(m), (tx) => assetList(tx, m.access, filter)),
		filter,
		canManage: canRunAssets(m.access)
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const m = requirePerm(locals, 'asset.manage');
		const form = formFields(await request.formData());
		let id: string;
		try {
			id = await saveAsset(m, { ...form, assetId: '' });
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
		redirect(303, `/t/${m.tenant.slug}/assets/${id}`);
	}
};
