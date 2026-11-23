import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { readSettings, saveSettings } from '#lib/server/settings.ts';
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
			fiscalYearStartMonth: s.fiscalYearStartMonth,
			weekendDays: s.weekendDays,
			employeeCodePrefix: s.employeeCodePrefix,
			require2faForSensitive: s.require2faForSensitive,
			allowSingleAdminApproval: s.allowSingleAdminApproval,
			exEmployeeAccessDays: s.exEmployeeAccessDays,
			noticePeriodDays: s.noticePeriodDays,
			retentionAuditDays: s.retentionAuditDays,
			retentionCandidatesDays: s.retentionCandidatesDays,
			overtimeDailyCapMinutes: s.overtimeDailyCapMinutes,
			compOffExpiryDays: s.compOffExpiryDays
		},
		timezones: Intl.supportedValuesOf('timeZone'),
		isOwner: m.access.isOwner
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const m = requirePerm(locals, 'settings.manage');
		const form = await request.formData();
		try {
			await saveSettings(userCtx(m), m.access.isOwner, {
				legalName: field(form, 'legalName'),
				address: field(form, 'address'),
				timezone: field(form, 'timezone'),
				fiscalYearStartMonth: field(form, 'fiscalYearStartMonth'),
				weekendDays: form.getAll('weekendDays').map(String),
				employeeCodePrefix: field(form, 'employeeCodePrefix'),
				require2faForSensitive: field(form, 'require2faForSensitive'),
				allowSingleAdminApproval: field(form, 'allowSingleAdminApproval'),
				exEmployeeAccessDays: field(form, 'exEmployeeAccessDays'),
				noticePeriodDays: field(form, 'noticePeriodDays'),
				retentionAuditDays: field(form, 'retentionAuditDays'),
				retentionCandidatesDays: field(form, 'retentionCandidatesDays'),
				overtimeDailyCapMinutes: field(form, 'overtimeDailyCapMinutes'),
				compOffExpiryDays: field(form, 'compOffExpiryDays')
			});
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { saved: true };
	}
};
