import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { canRunProjects, projectList, saveProject } from '#lib/server/projects.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'project.read');
	return {
		projects: await withTenant(userCtx(m), (tx) => projectList(tx, m.access)),
		canManage: canRunProjects(m.access)
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const m = requirePerm(locals, 'project.manage');
		const form = formFields(await request.formData());
		let id: string;
		try {
			id = await saveProject(m, { ...form, projectId: '' });
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values: form });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { ...failed.data, values: form });
		}
		redirect(303, `/t/${m.tenant.slug}/projects/${id}`);
	}
};
