import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { now } from '#lib/server/clock.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import {
	addHoliday,
	addOrgItem,
	holidaysOf,
	isOrgKind,
	orgStructure,
	removeHoliday,
	removeOrgItem,
	updateOrgItem
} from '#lib/server/org.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { TIMEZONES } from '#lib/server/settings.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

const yearOf = (raw: string | null) => {
	const y = Number(raw);
	return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : now().getUTCFullYear();
};

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = requirePerm(locals, 'org.manage');
	const year = yearOf(url.searchParams.get('year'));
	return withTenant(userCtx(m), async (tx) => ({
		...(await orgStructure(tx)),
		year,
		timezones: TIMEZONES,
		holidays: await holidaysOf(tx, year)
	}));
};

const item = (form: FormData) => ({
	name: field(form, 'name'),
	parentId: field(form, 'parentId'),
	address: field(form, 'address'),
	timezone: field(form, 'timezone'),
	rank: field(form, 'rank') || undefined
});

async function run(locals: App.Locals, fn: (ctx: ReturnType<typeof userCtx>) => Promise<unknown>) {
	const m = requirePerm(locals, 'org.manage');
	try {
		await fn(userCtx(m));
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, locals.requestId);
	}
	return { saved: true };
}

const kindOf = (form: FormData) => {
	const kind = field(form, 'kind');
	if (!isOrgKind(kind)) throw new z.ZodError([{ code: 'custom', message: 'Unknown record type.', path: ['kind'] }]);
	return kind;
};

export const actions: Actions = {
	add: async ({ request, locals }) => {
		requirePerm(locals, 'org.manage');
		const form = await request.formData();
		return run(locals, (ctx) => addOrgItem(ctx, kindOf(form), item(form)));
	},
	update: async ({ request, locals }) => {
		requirePerm(locals, 'org.manage');
		const form = await request.formData();
		return run(locals, (ctx) => updateOrgItem(ctx, kindOf(form), field(form, 'id'), item(form)));
	},
	remove: async ({ request, locals }) => {
		requirePerm(locals, 'org.manage');
		const form = await request.formData();
		return run(locals, (ctx) => removeOrgItem(ctx, kindOf(form), field(form, 'id')));
	},
	addHoliday: async ({ request, locals }) => {
		requirePerm(locals, 'org.manage');
		const form = await request.formData();
		return run(locals, (ctx) => addHoliday(ctx, { date: field(form, 'date'), name: field(form, 'name') }));
	},
	removeHoliday: async ({ request, locals }) => {
		requirePerm(locals, 'org.manage');
		const form = await request.formData();
		return run(locals, (ctx) => removeHoliday(ctx, field(form, 'id')));
	}
};
