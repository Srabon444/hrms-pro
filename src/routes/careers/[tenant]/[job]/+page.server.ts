import { careersApplyAction, careersJobLoad } from '#lib/server/public/careers.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });
	return careersJobLoad(params.tenant, params.job);
};

export const actions: Actions = {
	default: async ({ params, request, getClientAddress, locals }) =>
		careersApplyAction(params.tenant, params.job, getClientAddress(), request, locals.requestId)
};
