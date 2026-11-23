import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { actionError } from '#lib/server/http/forms.ts';
import { closeCycle, cycleView } from '#lib/server/performance.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const m = requirePerm(locals, 'performance.read');
	const page = Math.max(1, Math.trunc(Number(url.searchParams.get('page'))) || 1);
	const view = await withTenant(userCtx(m), (tx) => cycleView(tx, m.access, params.cycleId, page));
	if (!view) error(404, 'That review cycle does not exist.');
	return { view };
};

export const actions: Actions = {
	close: async ({ locals, params }) => {
		const m = requirePerm(locals, 'performance.manage');
		try {
			await closeCycle(m, { cycleId: params.cycleId });
			return { done: 'Review cycle closed.' };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
	}
};
