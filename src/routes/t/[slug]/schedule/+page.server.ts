import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requireModule } from '#lib/server/modules.ts';
import { can, userCtx } from '#lib/server/rbac/access.ts';
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
import {
	answerSwap,
	cancelSwap,
	claimOpenShift,
	decideClaim,
	decideSwap,
	myShiftTrades,
	openShiftsIn,
	postOpenShift,
	removeOpenShift,
	requestSwap,
	swapOptions,
	tradesToDecide,
	withdrawClaim
} from '#lib/server/shift-swaps.ts';
import { addDays } from '#lib/server/dates.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = await requireModule(locals, 'schedule', 'schedule.read');
	return withTenant(userCtx(m), async (tx) => {
		const week = await scheduleWeek(tx, m.access, url.searchParams.get('week'));
		const end = addDays(week.start, 6);
		return {
			week,
			me: m.access.employeeId,
			availability: await myAvailability(tx, m.access),
			open: await openShiftsIn(tx, m.access, m.user.userId, week.start, end),
			trades: await myShiftTrades(tx, m.access),
			toDecide: await tradesToDecide(tx, m.access),
			colleagues: can(m.access, 'schedule.swap') ? await swapOptions(tx, m.access, week.start, end) : []
		};
	});
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
	},
	postOpen: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.manage');
		const form = await request.formData();
		return run(
			() => postOpenShift(m, fields(form)),
			locals.requestId,
			() => ({ openPosted: true })
		);
	},
	removeOpen: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.manage');
		const form = await request.formData();
		return run(
			() => removeOpenShift(m, field(form, 'entryId')),
			locals.requestId,
			() => ({ openRemoved: true })
		);
	},
	claim: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.swap');
		const form = await request.formData();
		return run(
			() => claimOpenShift(m, field(form, 'entryId')),
			locals.requestId,
			() => ({ claimed: true })
		);
	},
	withdrawClaim: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.swap');
		const form = await request.formData();
		return run(
			() => withdrawClaim(m, field(form, 'claimId')),
			locals.requestId,
			() => ({ withdrawn: true })
		);
	},
	decideClaim: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.read');
		const form = await request.formData();
		return run(
			() => decideClaim(m, field(form, 'claimId'), field(form, 'decision')),
			locals.requestId,
			() => ({ decided: true })
		);
	},
	requestSwap: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.swap');
		const form = await request.formData();
		return run(
			() => requestSwap(m, fields(form)),
			locals.requestId,
			() => ({ swapAsked: true })
		);
	},
	answerSwap: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.swap');
		const form = await request.formData();
		return run(
			() => answerSwap(m, field(form, 'swapId'), field(form, 'answer')),
			locals.requestId,
			() => ({ answered: true })
		);
	},
	cancelSwap: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.swap');
		const form = await request.formData();
		return run(
			() => cancelSwap(m, field(form, 'swapId')),
			locals.requestId,
			() => ({ cancelled: true })
		);
	},
	decideSwap: async ({ request, locals }) => {
		const m = await requireModule(locals, 'schedule', 'schedule.read');
		const form = await request.formData();
		return run(
			() => decideSwap(m, field(form, 'swapId'), field(form, 'decision')),
			locals.requestId,
			(status) => ({ swapStatus: status })
		);
	}
};
