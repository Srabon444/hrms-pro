import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { DOCUMENT_CATEGORIES } from '#lib/server/db/schema/org.ts';
import { deleteDocument, listDocuments, uploadDocument } from '#lib/server/documents.ts';
import { employeeChoices, getEmployee, updateEmployee } from '#lib/server/employees.ts';
import { employeeActionError, formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'employee.read');
	return withTenant(userCtx(m), async (tx) => {
		const record = await getEmployee(tx, m.access, params.employeeId);
		if (!record) error(404, 'Not found');
		return {
			...record,
			choices: record.canUpdate ? await employeeChoices(tx) : null,
			documents: await listDocuments(tx, m.access, record.employee.id),
			documentCategories: DOCUMENT_CATEGORIES
		};
	});
};

export const actions: Actions = {
	save: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'employee.update');
		const values = formFields(await request.formData());
		try {
			await updateEmployee(userCtx(m), m.access, params.employeeId, values);
		} catch (err) {
			return employeeActionError(err, locals.requestId, values);
		}
		return { saved: true };
	},
	upload: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'document.manage');
		const form = await request.formData();
		const file = form.get('file');
		try {
			await uploadDocument(
				userCtx(m),
				m.access,
				params.employeeId,
				formFields(form),
				file instanceof File ? file : null
			);
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { docMessage: err.issues[0].message });
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { docMessage: failed.data.message });
		}
		return { uploaded: true };
	},
	removeDocument: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'document.manage');
		try {
			await deleteDocument(userCtx(m), m.access, params.employeeId, field(await request.formData(), 'documentId'));
		} catch (err) {
			const failed = actionError(err, locals.requestId);
			return fail(failed.status, { docMessage: failed.data.message });
		}
		return { removed: true };
	}
};
