import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import {
	addTemplateItem,
	createTemplate,
	listTemplates,
	removeTemplateItem,
	setTemplateActive
} from '#lib/server/checklists.ts';
import { CHECKLIST_KINDS } from '#lib/server/db/schema/org.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'settings.manage');
	return { ...(await withTenant(userCtx(m), listTemplates)), kinds: CHECKLIST_KINDS };
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
	create: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		const form = formFields(await request.formData());
		return run(() => createTemplate(userCtx(m), form), locals.requestId);
	},
	addItem: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		const form = await request.formData();
		return run(() => addTemplateItem(userCtx(m), field(form, 'templateId'), formFields(form)), locals.requestId);
	},
	removeItem: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		const form = await request.formData();
		return run(
			() => removeTemplateItem(userCtx(m), field(form, 'templateId'), field(form, 'itemId')),
			locals.requestId
		);
	},
	toggle: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		const form = await request.formData();
		return run(
			() => setTemplateActive(userCtx(m), field(form, 'templateId'), field(form, 'active') === 'true'),
			locals.requestId
		);
	}
};
