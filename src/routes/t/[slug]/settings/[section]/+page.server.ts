import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { readSettings, saveSection } from '#lib/server/settings.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { SETTING_SECTIONS, type SectionId } from '#lib/settings-sections.ts';
import type { Actions, PageServerLoad } from './$types';

const sectionOf = (id: string): SectionId => {
	if (!Object.hasOwn(SETTING_SECTIONS, id)) error(404, 'Not found');
	return id as SectionId;
};

export const load: PageServerLoad = async ({ locals, params }) => {
	const id = sectionOf(params.section);
	const m = requirePerm(locals, 'settings.manage');
	const s = await withTenant(userCtx(m), readSettings);
	return {
		id,
		values: Object.fromEntries(
			SETTING_SECTIONS[id].fields.map((f) => [f.key, s[f.key as keyof typeof s] as number | boolean])
		),
		isOwner: m.access.isOwner
	};
};

export const actions: Actions = {
	default: async ({ request, locals, params }) => {
		const id = sectionOf(params.section);
		const m = requirePerm(locals, 'settings.manage');
		try {
			await saveSection(userCtx(m), m.access.isOwner, id, formFields(await request.formData()));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { saved: true };
	}
};
