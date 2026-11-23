import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { AppError } from '#lib/server/errors.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { can, requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import {
	cancelInterview,
	candidateView,
	decideOffer,
	hireCandidate,
	interviewerChoices,
	makeOffer,
	moveCandidate,
	scheduleInterview
} from '#lib/server/recruitment.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'recruitment.read');
	const canManage = can(m.access, 'recruitment.manage');
	try {
		return await withTenant(userCtx(m), async (tx) => ({
			view: await candidateView(tx, params.candidateId, m.access.membershipId),
			interviewers: canManage ? await interviewerChoices(tx) : [],
			canManage,
			canHire: can(m.access, 'employee.create'),
			canInvite: can(m.access, 'user.manage')
		}));
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	}
};

const fail400 = (err: unknown, requestId: string) =>
	err instanceof z.ZodError ? fail(400, { message: err.issues[0].message }) : actionError(err, requestId);

export const actions: Actions = {
	move: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'recruitment.manage');
		const form = formFields(await request.formData());
		try {
			await moveCandidate(userCtx(m), { ...form, candidateId: params.candidateId });
			return { done: 'Candidate moved.' };
		} catch (err) {
			return fail400(err, locals.requestId);
		}
	},
	schedule: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'recruitment.manage');
		const data = await request.formData();
		const panel = data.getAll('interviewers').filter((v): v is string => typeof v === 'string');
		try {
			await scheduleInterview(
				userCtx(m),
				m.tenant.slug,
				{ ...formFields(data), candidateId: params.candidateId },
				panel
			);
			return { done: 'Interview scheduled. The panel has been notified.' };
		} catch (err) {
			return fail400(err, locals.requestId);
		}
	},
	cancel: async ({ request, locals }) => {
		const m = requirePerm(locals, 'recruitment.manage');
		const form = formFields(await request.formData());
		try {
			await cancelInterview(userCtx(m), form.interviewId ?? '');
			return { done: 'Interview cancelled.' };
		} catch (err) {
			return fail400(err, locals.requestId);
		}
	},
	offer: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'recruitment.manage');
		const form = formFields(await request.formData());
		try {
			await makeOffer(userCtx(m), { ...form, candidateId: params.candidateId });
			return { done: 'Offer recorded.' };
		} catch (err) {
			return fail400(err, locals.requestId);
		}
	},
	decide: async ({ request, locals }) => {
		const m = requirePerm(locals, 'recruitment.manage');
		const form = formFields(await request.formData());
		try {
			await decideOffer(userCtx(m), form);
			return { done: 'Offer updated.' };
		} catch (err) {
			return fail400(err, locals.requestId);
		}
	},
	hire: async ({ request, locals, params }) => {
		const m = requirePerm(locals, 'recruitment.read');
		const form = formFields(await request.formData());
		try {
			const r = await hireCandidate(m, { ...form, candidateId: params.candidateId });
			return { done: r.invite ?? (form.invite === 'on' ? 'Hired. The invite is on its way.' : 'Hired.') };
		} catch (err) {
			return fail400(err, locals.requestId);
		}
	}
};
