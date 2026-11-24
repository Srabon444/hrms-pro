import { fail } from '@sveltejs/kit';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { now } from '#lib/server/clock.ts';
import { invitations, membershipRoles, roles } from '#lib/server/db/schema/index.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import {
	canHandOut,
	inviteMember,
	linkableEmployees,
	revokeInvitation,
	rolesWithGrants,
	toActor
} from '#lib/server/rbac/members.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

type MemberRow = {
	membership_id: string;
	membership_status: string;
	email: string;
	name: string;
	last_login_at: Date | null;
	totp_enabled: boolean;
	employee: string | null;
};

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'user.manage');
	const actor = toActor(m);
	return withTenant(actor.ctx, async (tx) => {
		const members = await tx.execute<MemberRow>(
			sql`select u.membership_id, u.membership_status, u.email, u.name, u.last_login_at, u.totp_enabled,
				e.full_name || ' (' || e.code || ')' as employee
				from tenant_users u left join employees e on e.id = u.employee_id order by u.name`
		);
		const assigned = await tx
			.select({ membershipId: membershipRoles.membershipId, name: roles.name })
			.from(membershipRoles)
			.innerJoin(roles, eq(roles.id, membershipRoles.roleId))
			.orderBy(roles.name);
		const pending = await tx
			.select({ id: invitations.id, email: invitations.email, expiresAt: invitations.expiresAt })
			.from(invitations)
			.where(and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now())))
			.orderBy(desc(invitations.createdAt));
		const allRoles = await rolesWithGrants(tx);
		return {
			members: members.map((r) => ({
				id: r.membership_id,
				status: r.membership_status,
				email: r.email,
				name: r.name,
				lastLoginAt: r.last_login_at ? new Date(r.last_login_at) : null,
				totpEnabled: r.totp_enabled,
				employee: r.employee,
				roles: assigned.filter((a) => a.membershipId === r.membership_id).map((a) => a.name),
				self: r.membership_id === m.access.membershipId
			})),
			pending,
			employees: await linkableEmployees(tx, m.access, null),
			grantableRoles: allRoles
				.filter((r) => r.key !== 'employee' && canHandOut(m.access, r))
				.map(({ id, name }) => ({ id, name }))
		};
	});
};

export const actions: Actions = {
	invite: async ({ request, locals }) => {
		const actor = toActor(requirePerm(locals, 'user.manage'));
		const form = await request.formData();
		const email = field(form, 'email');
		const roleIds = z.array(z.uuid()).safeParse(form.getAll('roleId'));
		const employeeId = z.uuid().or(z.literal('')).safeParse(field(form, 'employeeId'));
		if (!roleIds.success || !employeeId.success)
			return fail(400, { email, message: 'Choose roles and the employee from the list.' });
		try {
			await inviteMember(actor, { email, roleIds: roleIds.data, employeeId: employeeId.data || null });
		} catch (err) {
			if (err instanceof z.ZodError) return fail(400, { email, message: 'Enter a valid email address.' });
			return actionError(err, locals.requestId);
		}
		return { invited: email.trim().toLowerCase() };
	},
	revoke: async ({ request, locals }) => {
		const actor = toActor(requirePerm(locals, 'user.manage'));
		const id = z.uuid().safeParse(field(await request.formData(), 'id'));
		if (!id.success) return fail(400, { message: 'That invitation is no longer pending.' });
		try {
			await revokeInvitation(actor, id.data);
		} catch (err) {
			return actionError(err, locals.requestId);
		}
		return { revoked: true };
	}
};
