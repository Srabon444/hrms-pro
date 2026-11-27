import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { listWorkSites, punchRule, savePunchRule, saveWorkSite, siteBranches } from '#lib/server/work-sites.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'attendance.manage');
	return withTenant(userCtx(m), async (tx) => ({
		sites: await listWorkSites(tx),
		branches: await siteBranches(tx),
		rule: await punchRule(tx)
	}));
};

async function run(fn: () => Promise<unknown>, requestId: string) {
	try {
		await fn();
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
	return { saved: true };
}

export const actions: Actions = {
	rule: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.manage');
		const form = await request.formData();
		return run(() => savePunchRule(userCtx(m), field(form, 'rule')), locals.requestId);
	},
	save: async ({ request, locals }) => {
		const m = requirePerm(locals, 'attendance.manage');
		const form = await request.formData();
		return run(() => saveWorkSite(userCtx(m), field(form, 'siteId'), formFields(form)), locals.requestId);
	}
};
