import { addCertification, learningPage, removeCertification, saveCourse, selfEnrol } from '#lib/server/learning.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { field } from '#lib/server/http/forms.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'learning');
	return withTenant(userCtx(m), (tx) => learningPage(tx, m.access));
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const m = await requireModule(locals, 'learning');
		const form = formFields(await request.formData());
		let courseId: string;
		try {
			courseId = await saveCourse(m, { ...form, courseId: '' });
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		redirect(303, `/t/${m.tenant.slug}/learning/${courseId}`);
	},
	enrol: async ({ request, locals }) => {
		const m = await requireModule(locals, 'learning');
		const form = formFields(await request.formData());
		try {
			await selfEnrol(m, form.courseId ?? '');
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		redirect(303, `/t/${m.tenant.slug}/learning/${form.courseId}`);
	},
	certify: async ({ request, locals }) => {
		const m = await requireModule(locals, 'learning');
		const form = formFields(await request.formData());
		try {
			await addCertification(m, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done: 'Certification added.' };
	},
	uncertify: async ({ request, locals }) => {
		const m = await requireModule(locals, 'learning');
		try {
			await removeCertification(m, formFields(await request.formData()).id ?? '');
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		return { done: 'Certification removed.' };
	},
	certificationFiles: async ({ request, locals }) => {
		const m = await requireModule(locals, 'learning');
		const form = await request.formData();
		return attachmentAction(m, form, 'certification', field(form, 'ownerId'), locals.requestId);
	}
};
