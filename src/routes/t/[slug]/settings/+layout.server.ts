import { error } from '@sveltejs/kit';
import { allowedSettingsPages } from '#lib/nav.ts';
import { can, requireMember } from '#lib/server/rbac/access.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	const pages = allowedSettingsPages((perm) => can(m.access, perm)).map(({ href, label, group, about }) => ({
		href,
		label,
		group,
		about
	}));
	if (!pages.length) error(403, 'You do not have permission to do that.');
	return { settingsPages: pages };
};
