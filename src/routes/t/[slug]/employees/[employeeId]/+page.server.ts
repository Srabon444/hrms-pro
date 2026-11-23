import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { cancelChange, CHANGE_LABELS, ownPendingChange, requestChange } from '#lib/server/change-requests.ts';
import { DOCUMENT_CATEGORIES, EXIT_TYPES } from '#lib/server/db/schema/org.ts';
import { exitRights, recordExit, rehire, withdrawExit } from '#lib/server/exits.ts';
import { deleteDocument, listDocuments, uploadDocument } from '#lib/server/documents.ts';
import { employeeChoices, getEmployee, updateEmployee } from '#lib/server/employees.ts';
import { employeeActionError, formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { addListEntry, profileLists, removeListEntry, updateOwnDetails } from '#lib/server/profile.ts';
import { requireMember, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { noticeTerms, ownResignation, submitResignation, withdrawResignation } from '#lib/server/resignations.ts';
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
			lists: await profileLists(tx, m.access, record.employee.id, record.employee.status),
			pendingChange: await ownPendingChange(tx, m.access, record.employee.id),
			changeLabels: CHANGE_LABELS,
			exit: await exitRights(tx, m.access, record.employee),
			exitTypes: EXIT_TYPES,
			resignation:
				m.access.employeeId === record.employee.id
					? { pending: await ownResignation(tx, m.access, record.employee.id), terms: await noticeTerms(tx) }
					: null,
			documentCategories: DOCUMENT_CATEGORIES
		};
	});
};

const profileError = (err: unknown, requestId: string) => {
	if (err instanceof z.ZodError) return fail(400, { profileMessage: err.issues[0].message });
	const failed = actionError(err, requestId);
	return fail(failed.status, { profileMessage: failed.data.message });
};

export const actions: Actions = {
	saveOwn: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		try {
			await updateOwnDetails(userCtx(m), m.access, params.employeeId, formFields(await request.formData()));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { ownSaved: true };
	},
	recordExit: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'employee.delete');
		try {
			await recordExit(m, params.employeeId, formFields(await request.formData()));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { exitRecorded: true };
	},
	withdrawExit: async ({ locals, params }) => {
		const m = requirePerm(locals, 'employee.delete');
		try {
			await withdrawExit(m, params.employeeId);
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { exitWithdrawn: true };
	},
	rehire: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'employee.create');
		try {
			await rehire(m, params.employeeId, formFields(await request.formData()));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { rehired: true };
	},
	resign: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		try {
			await submitResignation(m, params.employeeId, formFields(await request.formData()));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { resigned: true };
	},
	withdrawResignation: async ({ request, locals }) => {
		const m = requireMember(locals);
		try {
			await withdrawResignation(m, field(await request.formData(), 'resignationId'));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { resignationWithdrawn: true };
	},
	requestChange: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		try {
			await requestChange(m, params.employeeId, formFields(await request.formData()));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { changeRequested: true };
	},
	cancelChange: async ({ request, locals }) => {
		const m = requireMember(locals);
		try {
			await cancelChange(m, field(await request.formData(), 'requestId'));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { changeCancelled: true };
	},
	addEntry: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		const form = await request.formData();
		try {
			await addListEntry(userCtx(m), m.access, params.employeeId, field(form, 'kind'), formFields(form));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { entryAdded: true };
	},
	removeEntry: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		const form = await request.formData();
		try {
			await removeListEntry(userCtx(m), m.access, params.employeeId, field(form, 'kind'), field(form, 'entryId'));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { entryRemoved: true };
	},
	save: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'employee.update');
		const values = formFields(await request.formData());
		try {
			await updateEmployee(userCtx(m), m.access, params.employeeId, values, m.tenant.slug);
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
