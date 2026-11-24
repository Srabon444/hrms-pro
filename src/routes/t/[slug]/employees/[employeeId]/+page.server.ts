import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { employeeChecklists, roleNames, setTaskDone } from '#lib/server/checklists.ts';
import { cancelChange, CHANGE_LABELS, ownPendingChange, requestChange } from '#lib/server/change-requests.ts';
import { DOCUMENT_CATEGORIES, EXIT_TYPES } from '#lib/server/db/schema/org.ts';
import { exitInterviewView, submitExitInterview } from '#lib/server/exit-interviews.ts';
import { exitRights, recordExit, rehire, withdrawExit } from '#lib/server/exits.ts';
import { listFiles } from '#lib/server/attachments.ts';
import { deleteDocument, listDocuments, uploadDocument } from '#lib/server/documents.ts';
import { employeeChoices, getEmployee, updateEmployee } from '#lib/server/employees.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { employeeActionError, formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { adjustLeave, leaveBalances } from '#lib/server/leave.ts';
import { tenantToday } from '#lib/server/lifecycle.ts';
import { addListEntry, profileLists, removeListEntry, updateOwnDetails } from '#lib/server/profile.ts';
import { requireMember, requirePerm, userCtx, type Access } from '#lib/server/rbac/access.ts';
import { assignShift, employeeShift, removeShiftAssignment } from '#lib/server/shifts.ts';
import { noticeTerms, ownResignation, submitResignation, withdrawResignation } from '#lib/server/resignations.ts';
import { withTenant, type Tx } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

async function ownResignationView(tx: Tx, access: Access, employeeId: string) {
	const pending = await ownResignation(tx, access, employeeId);
	return {
		pending,
		terms: await noticeTerms(tx),
		files: pending ? await listFiles(tx, access, 'resignation', pending.id) : null
	};
}

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
			exitInterview: await exitInterviewView(tx, m.access, record.employee),
			resignation:
				m.access.employeeId === record.employee.id ? await ownResignationView(tx, m.access, record.employee.id) : null,
			leave: await leaveBalances(tx, m.access, record.employee),
			shift: await employeeShift(tx, m.access, record.employee, await tenantToday(tx)),
			checklists: await employeeChecklists(tx, m.access, record.employee),
			roleNames: await roleNames(tx),
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
	exitInterview: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		try {
			await submitExitInterview(m, params.employeeId, formFields(await request.formData()));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { interviewSaved: true };
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
	adjustLeave: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'leave.manage');
		try {
			await adjustLeave(m, params.employeeId, formFields(await request.formData()));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { leaveAdjusted: true };
	},
	assignShift: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'attendance.manage');
		try {
			await assignShift(m, params.employeeId, formFields(await request.formData()));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { shiftSaved: true };
	},
	removeShift: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'attendance.manage');
		try {
			await removeShiftAssignment(m, params.employeeId, field(await request.formData(), 'assignmentId'));
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { shiftSaved: true };
	},
	task: async ({ request, locals }) => {
		const m = requireMember(locals);
		const form = await request.formData();
		try {
			await setTaskDone(m, field(form, 'itemId'), field(form, 'done') === 'true');
		} catch (err) {
			return profileError(err, locals.requestId);
		}
		return { taskSaved: true };
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
	resignationFiles: async ({ request, locals, params }) => {
		const m = requireMember(locals);
		const own = await withTenant(userCtx(m), (tx) => ownResignation(tx, m.access, params.employeeId));
		if (!own) return fail(404, { fileMessage: 'You have no open resignation.' });
		return attachmentAction(m, await request.formData(), 'resignation', own.id, locals.requestId);
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
