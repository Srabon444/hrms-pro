import { kioskPunchAction, kioskScreen } from '#lib/server/public/kiosk.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, getClientAddress, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
	return { kiosk: await kioskScreen(cookies, getClientAddress()) };
};

export const actions: Actions = {
	default: async ({ cookies, getClientAddress, request, locals }) =>
		kioskPunchAction(cookies, getClientAddress(), await request.formData(), locals.requestId)
};
