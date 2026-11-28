import { error } from '@sveltejs/kit';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { applyInternal, jobBoard, referCandidate, rewardList, settleReward } from '#lib/server/job-board.ts';
import { requireModule } from '#lib/server/modules.ts';
import { can, userCtx } from '#lib/server/rbac/access.ts';
import { salaryCtx } from '#lib/server/salaries.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'talent');
	if (locals.membership?.status !== 'active') error(403, 'You do not have permission to do that.');
	const canPay = can(m.access, 'salary.update');
	return {
		...(await withTenant(userCtx(m), (tx) => jobBoard(tx, m.access))),
		rewards: can(m.access, 'salary.read') ? await withTenant(salaryCtx(m), rewardList) : null,
		canPay,
		isEmployee: !!m.access.employeeId
	};
};

type Member = Awaited<ReturnType<typeof requireModule>>;

const run =
	(step: (m: Member, form: Record<string, string>) => Promise<unknown>, done: string): Actions[string] =>
	async ({ request, locals }) => {
		const m = await requireModule(locals, 'talent');
		const form = formFields(await request.formData());
		try {
			await step(m, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done };
	};

export const actions: Actions = {
	apply: run((m, form) => applyInternal(m, form), 'Application sent to the hiring team.'),
	refer: run((m, form) => referCandidate(m, form), 'Referral sent to the hiring team.'),
	settle: run((m, form) => settleReward(m, form), 'Reward updated.')
};
