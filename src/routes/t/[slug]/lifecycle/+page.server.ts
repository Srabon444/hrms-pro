import { filesFor } from '#lib/server/attachments.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { roleNames, scopeTasks, setTaskDone } from '#lib/server/checklists.ts';
import { upcomingExits } from '#lib/server/exits.ts';
import { decideProbation, probationDue } from '#lib/server/lifecycle.ts';
import { requireMember, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'employee.update');
	return withTenant(userCtx(m), async (tx) => {
		const tasks = await scopeTasks(tx, m.access);
		return {
			probation: await probationDue(tx, m.access),
			exits: await upcomingExits(tx, m.access),
			tasks,
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
	probation: async ({ request, locals }) => {
		const m = requirePerm(locals, 'employee.update');
		const form = await request.formData();
		try {
			await decideProbation(m, field(form, 'employeeId'), formFields(form));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { probationSaved: field(form, 'decision') };
	},
	task: async ({ request, locals }) => {
		const m = requirePerm(locals, 'employee.update');
		const form = await request.formData();
		try {
			await setTaskDone(m, field(form, 'itemId'), field(form, 'done') === 'true');
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { taskSaved: true };
	}
};
