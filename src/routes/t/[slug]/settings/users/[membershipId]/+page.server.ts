import { error, fail } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { membershipRoles } from '#lib/server/db/schema/index.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import { canHandOut, rolesWithGrants, setMemberRoles, setMemberStatus, toActor } from '#lib/server/rbac/members.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

const idOf = (raw: string) => {
	const id = z.uuid().safeParse(raw);
	if (!id.success) error(404, 'Not found');
	return id.data;
};

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requirePerm(locals, 'user.manage');
	const membershipId = idOf(params.membershipId);
	if (membershipId === m.access.membershipId) error(404, 'Not found');
	return withTenant(toActor(m).ctx, async (tx) => {
		const [member] = await tx.execute<{ name: string; email: string; membership_status: string }>(
			sql`select name, email, membership_status from tenant_users where membership_id = ${membershipId}`
		);
		if (!member) error(404, 'Not found');
		const held = new Set(
			(
				await tx
					.select({ roleId: membershipRoles.roleId })
					.from(membershipRoles)
					.where(eq(membershipRoles.membershipId, membershipId))
			).map((r) => r.roleId)
		);
		const all = await rolesWithGrants(tx);
		return {
			member: { id: membershipId, name: member.name, email: member.email, status: member.membership_status },
			roles: all
				.filter((r) => r.key !== 'employee')
				.map((r) => ({ id: r.id, name: r.name, held: held.has(r.id), editable: canHandOut(m.access, r) }))
		};
	});
};

export const actions: Actions = {
	roles: async ({ request, locals, params }) => {
		const actor = toActor(requirePerm(locals, 'user.manage'));
		const roleIds = z.array(z.uuid()).safeParse((await request.formData()).getAll('roleId'));
		if (!roleIds.success) return fail(400, { message: 'Choose roles from the list.' });
		try {
			await setMemberRoles(actor, idOf(params.membershipId), roleIds.data);
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { saved: 'Roles updated.' };
	},
	status: async ({ request, locals, params }) => {
		const actor = toActor(requirePerm(locals, 'user.manage'));
		const status = z.enum(['active', 'disabled']).safeParse(field(await request.formData(), 'status'));
		if (!status.success) return fail(400, { message: 'Unknown status.' });
		try {
			await setMemberStatus(actor, idOf(params.membershipId), status.data);
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { saved: status.data === 'active' ? 'Access restored.' : 'Access disabled.' };
	}
};
