import { applyCycle, clearProposal, closeCycle, cyclePage, propose, setBudget } from '#lib/server/comp.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) =>
	cyclePage(requireMember(locals), params.cycleId, url.searchParams.get('q') ?? '');

const step =
	(run: typeof propose, done: string) =>
	async ({ request, locals, params }: { request: Request; locals: App.Locals; params: { cycleId: string } }) => {
		const m = requireMember(locals);
		const form = formFields(await request.formData());
		try {
			await run(m, { ...form, cycleId: params.cycleId });
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done };
	};

export const actions: Actions = {
	propose: step(propose, 'Proposal saved.'),
	clear: step(clearProposal, 'Proposal removed.'),
	budget: step(setBudget, 'Budget saved.'),
	close: step(closeCycle, 'Pay review closed.'),
	apply: async ({ locals, params }) => {
		const m = requireMember(locals);
		try {
			const r = await applyCycle(m, { cycleId: params.cycleId });
			return {
				done: `${r.applied} salary change${r.applied === 1 ? '' : 's'} sent for approval.`,
				failures: r.failures
			};
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
	}
};
