import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { assetView, assignAsset, returnAsset, saveAsset } from '#lib/server/assets.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'asset.read');
	const view = await withTenant(userCtx(m), (tx) => assetView(tx, m.access, params.assetId));
	if (!view) error(404, 'That asset does not exist.');
	return { view };
};

const act =
	(
		step: (m: ReturnType<typeof requirePerm>, raw: Record<string, string>) => Promise<unknown>,
		done: string
	): Actions[string] =>
	async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'asset.manage');
		const form = formFields(await request.formData());
		try {
			await step(m, { ...form, assetId: params.assetId });
			return { done };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
	};

export const actions: Actions = {
	save: act(saveAsset, 'Asset saved.'),
	assign: act(assignAsset, 'Asset handed over.'),
	return: act(returnAsset, 'Asset closed out.')
};
