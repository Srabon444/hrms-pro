import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { myPayslips } from '#lib/server/payroll.ts';
import {
	PDF_PASSWORD_MAX,
	PDF_PASSWORD_MIN,
	pdfPasswordSet,
	removePdfPassword,
	setPdfPassword
} from '#lib/server/payslip-mail.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { readSettings } from '#lib/server/settings.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	const [payslips, pdf] = await Promise.all([
		myPayslips(m),
		withTenant(userCtx(m), async (tx) => ({
			emailed: (await readSettings(tx)).payslipEmailPdf,
			passwordSet: await pdfPasswordSet(tx, m.access.membershipId)
		}))
	]);
	return {
		payslips,
		pdf: { ...pdf, canSet: !!m.access.employeeId, min: PDF_PASSWORD_MIN, max: PDF_PASSWORD_MAX }
	};
};

export const actions: Actions = {
	setPdfPassword: async ({ request, locals }) => {
		const m = requireMember(locals);
		try {
			await setPdfPassword(m, formFields(await request.formData()));
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { pdfPasswordSaved: true };
	},
	removePdfPassword: async ({ locals }) => {
		const m = requireMember(locals);
		await removePdfPassword(m);
		return { pdfPasswordRemoved: true };
	}
};
