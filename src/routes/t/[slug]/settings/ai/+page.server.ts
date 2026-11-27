import { aiView, removeAiKey, saveAi, testAi } from '#lib/server/ai/settings.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'ai.manage');
	return aiView(m);
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const m = requirePerm(locals, 'ai.manage');
		try {
			await saveAi(m, await request.formData());
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { saved: true };
	},
	remove: async ({ locals }) => {
		const m = requirePerm(locals, 'ai.manage');
		try {
			await removeAiKey(m);
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { removed: true };
	},
	test: async ({ locals }) => {
		const m = requirePerm(locals, 'ai.manage');
		try {
			const r = await testAi(m);
			return { tested: r.model, platform: r.platform };
		} catch (err) {
			return actionError(err, locals.requestId);
		}
	}
};
