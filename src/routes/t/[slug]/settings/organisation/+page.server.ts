import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { CURRENCIES } from '#lib/money.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { readSettings, saveSettings, TIMEZONES } from '#lib/server/settings.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'settings.manage');
	const s = await withTenant(userCtx(m), readSettings);
	return {
		settings: {
			legalName: s.legalName ?? '',
			address: s.address ?? '',
			timezone: s.timezone,
			currency: s.currency,
			fiscalYearStartMonth: s.fiscalYearStartMonth,
			weekendDays: s.weekendDays,
			employeeCodePrefix: s.employeeCodePrefix
		},
		timezones: TIMEZONES,
		currencies: Object.keys(CURRENCIES)
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		const form = await request.formData();
		try {
			await saveSettings(userCtx(m), {
				legalName: field(form, 'legalName'),
				address: field(form, 'address'),
				timezone: field(form, 'timezone'),
				currency: field(form, 'currency'),
				fiscalYearStartMonth: field(form, 'fiscalYearStartMonth'),
				weekendDays: form.getAll('weekendDays').map(String),
				employeeCodePrefix: field(form, 'employeeCodePrefix')
			});
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { saved: true };
	}
};
