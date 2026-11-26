import { error, fail } from '@sveltejs/kit';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { authPool } from '#lib/server/db/index.ts';
import { memberships, tenants } from '#lib/server/db/schema/index.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { CURRENCIES } from '#lib/money.ts';
import { provisionTenant, setTenantStatus } from '#lib/server/platform/tenants.ts';
import { NEUTRAL_LOCALE, TIMEZONES } from '#lib/server/settings.ts';
import type { Actions, PageServerLoad } from './$types';

const admin = (locals: App.Locals) => {
	if (!locals.user?.isPlatformAdmin || !locals.user.totpEnabled) error(404, 'Not found');
	return locals.user;
};

export const load: PageServerLoad = async ({ locals }) => {
	admin(locals);
	const rows = await authPool()
		.db.select({
			id: tenants.id,
			slug: tenants.slug,
			name: tenants.name,
			status: tenants.status,
			members: count(memberships.id)
		})
		.from(tenants)
		.leftJoin(memberships, eq(memberships.tenantId, tenants.id))
		.groupBy(tenants.id)
		.orderBy(tenants.name);
	return { tenants: rows, timezones: TIMEZONES, currencies: Object.keys(CURRENCIES), locale: NEUTRAL_LOCALE };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = admin(locals);
		const form = await request.formData();
		const values = { slug: field(form, 'slug'), name: field(form, 'name'), ownerEmail: field(form, 'ownerEmail') };
		const locale = {
			timezone: field(form, 'timezone'),
			currency: field(form, 'currency'),
			fiscalYearStartMonth: field(form, 'fiscalYearStartMonth'),
			weekendDays: form.getAll('weekendDays').map(String)
		};
		try {
			const t = await provisionTenant({ ...values, locale }, user.userId);
			return { created: t.slug };
		} catch (err) {
			if (err instanceof z.ZodError)
				return fail(400, {
					...values,
					locale: {
						...locale,
						fiscalYearStartMonth: Number(locale.fiscalYearStartMonth),
						weekendDays: locale.weekendDays.map(Number)
					},
					message: err.issues.map((i) => i.message).join('. ')
				});
			return actionError(err, locals.requestId);
		}
	},
	status: async ({ request, locals }) => {
		const user = admin(locals);
		const form = await request.formData();
		const id = z.uuid().safeParse(field(form, 'tenantId'));
		const status = z.enum(['active', 'suspended']).safeParse(field(form, 'status'));
		if (!id.success || !status.success) return fail(400, { message: 'Invalid request.' });
		try {
			await setTenantStatus(id.data, status.data, user.userId);
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { updated: true };
	}
};
