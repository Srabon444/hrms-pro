import { pairKioskAction } from '#lib/server/public/kiosk.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'same-origin' });
	return {};
};

export const actions: Actions = {
	default: async ({ cookies, url, getClientAddress, request, locals }) =>
		pairKioskAction(cookies, url, getClientAddress(), await request.formData(), locals.requestId)
};
