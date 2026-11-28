import { createRequest, signaturesPage } from '#lib/server/esign.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireModule } from '#lib/server/modules.ts';
import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => signaturesPage(await requireModule(locals, 'esign'));

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const m = await requireModule(locals, 'esign', 'signature.manage');
		const form = await request.formData();
		let id: string;
		try {
			id = await createRequest(m, form);
		} catch (err) {
			return failed(err, locals.requestId, formFields(form));
		}
		redirect(303, `/t/${m.tenant.slug}/signatures/${id}`);
	}
};
