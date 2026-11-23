import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { taka } from '#lib/money.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { readSettings, savePayrollSettings } from '#lib/server/settings.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'settings.manage');
	const s = await withTenant(userCtx(m), readSettings);
	return {
		settings: {
			payrollProrationBasis: s.payrollProrationBasis,
			latePolicyCount: s.latePolicyCount,
			mealPayrollLagMonths: s.mealPayrollLagMonths,
			pfEmployeeRate: taka(s.pfEmployeeRateBp),
			pfEmployerRate: taka(s.pfEmployerRateBp),
			overtimeRate: taka(s.overtimeRateBp),
			overtimeMonthlyHours: s.overtimeMonthlyHours
		}
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		const form = formFields(await request.formData());
		try {
			await savePayrollSettings(userCtx(m), {
				...form,
				pfEmployeeRateBp: form.pfEmployeeRate ?? '',
				pfEmployerRateBp: form.pfEmployerRate ?? '',
				overtimeRateBp: form.overtimeRate ?? ''
			});
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { saved: true };
	}
};
