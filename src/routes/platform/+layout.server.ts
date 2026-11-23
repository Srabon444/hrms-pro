import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	if (!locals.user.isPlatformAdmin) error(404, 'Not found');
	if (!locals.user.totpEnabled) redirect(303, '/account/security?required=1');
	return {};
};
