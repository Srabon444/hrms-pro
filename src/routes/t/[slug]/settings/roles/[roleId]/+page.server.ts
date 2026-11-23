import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { canGrant } from '#lib/rbac/grants.ts';
import { PERMISSIONS, SCOPES, isRestricted } from '#lib/rbac/permissions.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import { rolesWithGrants, toActor } from '#lib/server/rbac/members.ts';
import { deleteRole, parseGrants, updateRole } from '#lib/server/rbac/roles.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

const idOf = (raw: string) => {
	const id = z.uuid().safeParse(raw);
	if (!id.success) error(404, 'Not found');
	return id.data;
};

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'role.manage');
	const [role] = await withTenant(toActor(m).ctx, (tx) => rolesWithGrants(tx, [idOf(params.roleId)]));
	if (!role) error(404, 'Not found');
	const held = new Set(role.grants.map(([p, s]) => `${p}:${s}`));
	const ownRole = m.access.roleKeys.includes(role.key) && !m.access.isOwner;
	const readOnly = role.locked || ownRole;
	return {
		role: { id: role.id, name: role.name, description: role.description ?? '', key: role.key, isSystem: role.isSystem },
		readOnly,
		reason: role.locked
			? 'This role always has every permission.'
			: ownRole
				? 'You cannot change a role you hold.'
				: null,
		scopes: SCOPES,
		rows: PERMISSIONS.map((p) => ({
			permission: p,
			restricted: isRestricted(p),
			cells: SCOPES.map((s) => ({
				scope: s,
				on: held.has(`${p}:${s}`),
				editable: !readOnly && canGrant(m.access, p, s) && !(role.key === 'employee' && isRestricted(p))
			}))
		}))
	};
};

export const actions: Actions = {
	save: async ({ request, locals, params }) => {
		const actor = toActor(requirePerm(locals, 'role.manage'));
		const form = await request.formData();
		const values = form.getAll('grant').filter((v): v is string => typeof v === 'string');
		try {
			await updateRole(actor, idOf(params.roleId), {
				name: field(form, 'name'),
				description: field(form, 'description'),
				grants: parseGrants(values)
			});
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
			return actionError(err, locals.requestId);
		}
		return { saved: true };
	},
	delete: async ({ locals, params }) => {
		const actor = toActor(requirePerm(locals, 'role.manage'));
		try {
			await deleteRole(actor, idOf(params.roleId));
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		redirect(303, `/t/${params.slug}/settings/roles`);
	}
};
