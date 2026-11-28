import { error } from '@sveltejs/kit';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { giveKudos, hideKudos, kudosPage, saveKudosValues } from '#lib/server/kudos.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'kudos');
	if (locals.membership?.status !== 'active') error(403, 'You do not have permission to do that.');
	return withTenant(userCtx(m), (tx) => kudosPage(tx, m.access));
};

const moderate =
	(hidden: boolean): Actions[string] =>
	async ({ request, locals }) => {
		const m = await requireModule(locals, 'kudos', 'kudos.moderate');
		const form = formFields(await request.formData());
		try {
			await hideKudos(m, form.kudosId ?? '', hidden);
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		return { done: hidden ? 'Kudos hidden.' : 'Kudos shown again.' };
	};

export const actions: Actions = {
	give: async ({ request, locals }) => {
		const m = await requireModule(locals, 'kudos');
		const data = await request.formData();
		const form = formFields(data);
		try {
			await giveKudos(m, {
				message: form.message,
				valueTag: form.valueTag,
				recipients: data.getAll('recipients').map(String)
			});
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done: 'Kudos sent.' };
	},
	hide: moderate(true),
	show: moderate(false),
	values: async ({ request, locals }) => {
		const m = await requireModule(locals, 'kudos', 'kudos.moderate');
		const form = formFields(await request.formData());
		try {
			await saveKudosValues(m, form.values ?? '');
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done: 'Values saved.' };
	}
};
