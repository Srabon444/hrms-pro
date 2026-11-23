import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	if (!locals.user || !locals.tenant || !locals.membership) error(404, 'Not found');
	return {
		tenant: locals.tenant,
		membership: { status: locals.membership.status },
		user: { name: locals.user.name, email: locals.user.email }
	};
};
