import { redirect } from '@sveltejs/kit';
import { LAST_TENANT_COOKIE } from '#lib/server/auth/cookies.ts';
import { listUserTenants } from '#lib/server/tenancy/resolve.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (!locals.user) redirect(303, '/login');
	const tenants = await listUserTenants(locals.user.userId, locals.user.ssoTenantId);
	const last = cookies.get(LAST_TENANT_COOKIE);
	const preferred = tenants.find((t) => t.slug === last) ?? (tenants.length === 1 ? tenants[0] : undefined);
	if (preferred && !locals.user.isPlatformAdmin) redirect(303, `/t/${preferred.slug}`);
	return { tenants, user: { name: locals.user.name, isPlatformAdmin: locals.user.isPlatformAdmin } };
};
