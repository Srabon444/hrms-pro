import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import {
	addAvailability,
	copyWeek,
	myAvailability,
	publishWeek,
	removeAvailability,
	removeEntry,
	saveEntry,
	scheduleWeek
} from '#lib/server/schedule.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = await requireModule(locals, 'schedule', 'schedule.read');
	return withTenant(userCtx(m), async (tx) => ({
		week: await scheduleWeek(tx, m.access, url.searchParams.get('week')),
		availability: await myAvailability(tx, m.access)
	}));
};

async function run<T, R extends Record<string, unknown>>(fn: () => Promise<T>, requestId: string, done: (v: T) => R) {
	try {
		return done(await fn());
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

const fields = (form: FormData) => Object.fromEntries([...form].map(([k, v]) => [k, String(v)]));

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.manage');
		const form = await request.formData();
		return run(
			() => saveEntry(m, fields(form)),
			locals.requestId,
			() => ({ saved: true })
		);
	},
	remove: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.manage');
		const form = await request.formData();
		return run(
			() => removeEntry(m, field(form, 'entryId')),
			locals.requestId,
			() => ({ removed: true })
		);
	},
	publish: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.manage');
		const form = await request.formData();
		return run(
			() => publishWeek(m, field(form, 'week')),
			locals.requestId,
			(r) => ({ published: r })
		);
	},
	copy: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.manage');
		const form = await request.formData();
		return run(
			() => copyWeek(m, field(form, 'week')),
			locals.requestId,
			(copied) => ({ copied })
		);
	},
	addAvailability: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.read');
		const form = await request.formData();
		return run(
			() => addAvailability(m, fields(form)),
			locals.requestId,
			() => ({ availabilitySaved: true })
		);
	},
	removeAvailability: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.read');
		const form = await request.formData();
		return run(
			() => removeAvailability(m, field(form, 'availabilityId')),
			locals.requestId,
			() => ({ availabilityRemoved: true })
		);
	}
};
