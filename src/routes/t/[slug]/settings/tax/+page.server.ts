import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { can, requireMember, requirePerm } from '#lib/server/rbac/access.ts';
import { confirmTaxYear, saveTaxProfile, saveTaxYear, startTaxYear, taxBoard, taxCtx } from '#lib/server/tax.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requireMember(locals);
	if (!can(m.access, 'settings.manage') && !can(m.access, 'payroll.run'))
		error(403, 'You do not have permission to do that.');
	const fy = url.searchParams.get('fy') ?? undefined;
	return { board: await withTenant(taxCtx(m), (tx) => taxBoard(tx, m, fy)) };
};

async function run(fn: () => Promise<unknown>, requestId: string, done: string) {
	try {
		await fn();
		return { done };
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

export const actions: Actions = {
	start: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		const form = formFields(await request.formData());
		return run(() => startTaxYear(m, form), locals.requestId, `Tax year ${form.fy} set up. Review and confirm it.`);
	},
	save: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		const form = formFields(await request.formData());
		return run(() => saveTaxYear(m, form), locals.requestId, 'Tax rules saved. Confirm them before payroll runs.');
	},
	confirm: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		const form = formFields(await request.formData());
		return run(() => confirmTaxYear(m, form), locals.requestId, 'Tax rules confirmed.');
	},
	profile: async ({ request, locals }) => {
		const m = requirePerm(locals, 'payroll.run');
		const form = formFields(await request.formData());
		return run(() => saveTaxProfile(m, form), locals.requestId, 'Tax profile saved.');
	}
};
