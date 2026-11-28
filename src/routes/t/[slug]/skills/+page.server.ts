import { error } from '@sveltejs/kit';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { addSkill, removeMySkill, removeSkill, setMySkill, skillsPage, validateSkill } from '#lib/server/skills.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = await requireModule(locals, 'talent');
	if (locals.membership?.status !== 'active') error(403, 'You do not have permission to do that.');
	return withTenant(userCtx(m), (tx) => skillsPage(tx, m.access));
};

type Member = Awaited<ReturnType<typeof requireModule>>;

const run =
	(step: (m: Member, form: Record<string, string>) => Promise<unknown>, done: string): Actions[string] =>
	async ({ request, locals }) => {
		const m = await requireModule(locals, 'talent');
		const form = formFields(await request.formData());
		try {
			await step(m, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done };
	};

export const actions: Actions = {
	set: run((m, form) => setMySkill(m, form), 'Skill saved. Your manager will validate it.'),
	drop: run((m, form) => removeMySkill(m, form.skillId ?? ''), 'Skill removed.'),
	validate: run((m, form) => validateSkill(m, form), 'Skill validated.'),
	add: run((m, form) => addSkill(m, form), 'Skill added to the catalogue.'),
	remove: run((m, form) => removeSkill(m, form.skillId ?? ''), 'Skill removed from the catalogue.')
};
