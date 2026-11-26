import { listDirectory, setShowBirthday } from '#lib/server/directory.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = await requireModule(locals, 'directory', 'directory.read');
	return withTenant(userCtx(m), (tx) => listDirectory(tx, m.access, Object.fromEntries(url.searchParams)));
};

export const actions: Actions = {
	birthday: async ({ request, locals }) => {
		await requireModule(locals, 'directory', 'directory.read');
		const m = await requireModule(locals, 'celebrations_birthdays');
		try {
			await setShowBirthday(userCtx(m), m.access, (await request.formData()).get('show') === 'on');
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { saved: true };
	}
};
