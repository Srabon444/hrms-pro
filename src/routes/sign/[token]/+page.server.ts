import { signActions, signPageLoad } from '#lib/server/public/esign.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, getClientAddress, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-robots-tag': 'noindex' });
	return signPageLoad(params.token, getClientAddress());
};

export const actions: Actions = {
	code: async ({ params, getClientAddress, locals }) =>
		signActions.code(params.token, getClientAddress(), locals.requestId),
	sign: async ({ params, getClientAddress, request, locals }) =>
		signActions.sign(
			params.token,
			getClientAddress(),
			request.headers.get('user-agent') ?? '',
			request,
			locals.requestId
		),
	decline: async ({ params, getClientAddress, request, locals }) =>
		signActions.decline(params.token, getClientAddress(), request, locals.requestId)
};
