import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { listFiles } from '#lib/server/attachments.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { projectView, removeProjectMember, saveProject, setProjectMember } from '#lib/server/projects.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'project.read');
	const page = await withTenant(userCtx(m), async (tx) => {
		const view = await projectView(tx, m.access, params.projectId);
		return view && { view, attachments: await listFiles(tx, m.access, 'project', params.projectId) };
	});
	if (!page) error(404, 'That project does not exist.');
	return page;
};

const act =
	(
		step: (m: ReturnType<typeof requirePerm>, raw: Record<string, string>) => Promise<unknown>,
		done: string
	): Actions[string] =>
	async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'project.manage');
		const form = formFields(await request.formData());
		try {
			await step(m, { ...form, projectId: params.projectId });
			return { done };
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
	};

export const actions: Actions = {
	files: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'project.read');
		return attachmentAction(m, await request.formData(), 'project', params.projectId, locals.requestId);
	},
	save: act(saveProject, 'Project saved.'),
	member: act(setProjectMember, 'Team updated.'),
	remove: act(removeProjectMember, 'Removed from the project.')
};
