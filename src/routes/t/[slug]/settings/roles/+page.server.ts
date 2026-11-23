import { fail, redirect } from '@sveltejs/kit';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { membershipRoles, roles } from '#lib/server/db/schema/index.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import { toActor } from '#lib/server/rbac/members.ts';
import { createRole } from '#lib/server/rbac/roles.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const actor = toActor(requirePerm(locals, 'role.manage'));
	const list = await withTenant(actor.ctx, (tx) =>
		tx
			.select({
				id: roles.id,
				name: roles.name,
				description: roles.description,
				isSystem: roles.isSystem,
				locked: roles.locked,
				members: count(membershipRoles.id)
			})
			.from(roles)
			.leftJoin(membershipRoles, eq(membershipRoles.roleId, roles.id))
			.groupBy(roles.id)
			.orderBy(roles.name)
	);
	return { roles: list };
};

export const actions: Actions = {
	create: async ({ request, locals, params }) => {
		const actor = toActor(requirePerm(locals, 'role.manage'));
		const form = await request.formData();
		const name = field(form, 'name');
		let id: string;
		try {
			id = await createRole(actor, { name, description: field(form, 'description') });
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { name, message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		redirect(303, `/t/${params.slug}/settings/roles/${id}`);
	}
};
