import { filesFor } from '#lib/server/attachments.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { myTasks, roleNames, setTaskDone } from '#lib/server/checklists.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { inScope, resolveScope } from '#lib/server/rbac/scope.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	return withTenant(userCtx(m), async (tx) => {
		const tasks = await myTasks(tx, m.access);
		const scope = await resolveScope(tx, m.access, 'employee.read');
		return {
			tasks: tasks.map((t) => ({ ...t, readable: inScope(scope, t.employeeId) })),
			taskFiles: Object.fromEntries(
				await filesFor(
					tx,
					'checklist_item',
					tasks.map((t) => t.id)
				)
			),
			roleNames: await roleNames(tx)
		};
	});
};

export const actions: Actions = {
	taskFiles: async ({ request, locals }) => {
		const m = requireMember(locals);
		const form = await request.formData();
		return attachmentAction(m, form, 'checklist_item', field(form, 'ownerId'), locals.requestId);
	},
	task: async ({ request, locals }) => {
		const m = requireMember(locals);
		const form = await request.formData();
		try {
			await setTaskDone(m, field(form, 'itemId'), field(form, 'done') === 'true');
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { taskSaved: true };
	}
};
