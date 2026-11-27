import { error } from '@sveltejs/kit';
import { allowedSettingsPages } from '#lib/nav.ts';
import { modulesOn } from '#lib/server/modules.ts';
import { can, requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	const m = requireMember(locals);
	const modules = await withTenant(userCtx(m), modulesOn);
	const pages = allowedSettingsPages((perm) => can(m.access, perm), modules).map(({ href, label, group, about }) => ({
		href,
		label,
		group,
		about
	}));
	if (!pages.length) error(403, 'You do not have permission to do that.');
	return { settingsPages: pages };
};
