import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authPool, closePools } from '../../src/lib/server/db';
import { employees, invitations, memberships } from '../../src/lib/server/db/schema';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess } from '../../src/lib/server/rbac/access';
import {
	inviteMember,
	linkEmployee,
	setMemberRoles,
	setMemberStatus,
	type Actor
} from '../../src/lib/server/rbac/members';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { resolveTenantAccess } from '../../src/lib/server/tenancy/resolve';
import { createInvitation } from '../../src/lib/server/invitations';
import { registerFromInvitation } from '../../src/lib/server/auth/service';
import { findUserByEmail } from '../../src/lib/server/auth/users';
import { createTenant, createUser } from './helpers';

let tenant: { id: string; slug: string };
let roleIds: Record<string, string>;

async function member(keys: string[]) {
	const u = await createUser();
	const id = await withTenant(systemCtx(tenant.id), (tx) => addMember(tx, tenant.id, u.id, keys));
	return { id, userId: u.id, email: u.email };
}

async function actorFor(m: { id: string; userId: string }): Promise<Actor> {
	return {
		ctx: { tenantId: tenant.id, userId: m.userId, actor: 'user' },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id: m.id, status: 'active', employeeId: null })
	};
}

const code = (p: Promise<unknown>) => p.then(() => 'ok').catch((e: { code?: string }) => e.code ?? String(e));

beforeAll(async () => {
	tenant = await createTenant('members');
	roleIds = await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
});

afterAll(closePools);

describe('member management guards', () => {
	it('HR admin can invite with roles they cover but not payroll or owner roles', async () => {
		const hr = await actorFor(await member(['hr_admin']));
		expect(await code(inviteMember(hr, { email: 'officer@members.test', roleIds: [roleIds.hr_officer] }))).toBe('ok');
		expect(await code(inviteMember(hr, { email: 'pay@members.test', roleIds: [roleIds.payroll_officer] }))).toBe(
			'role_not_grantable'
		);
		expect(await code(inviteMember(hr, { email: 'own@members.test', roleIds: [roleIds.owner] }))).toBe(
			'role_not_grantable'
		);
	});

	it('refuses to invite an existing active member', async () => {
		const owner = await actorFor(await member(['owner']));
		const staff = await member([]);
		expect(await code(inviteMember(owner, { email: staff.email, roleIds: [] }))).toBe('already_member');
	});

	it('nobody changes their own roles or status', async () => {
		const hrMember = await member(['hr_admin']);
		const hr = await actorFor(hrMember);
		expect(await code(setMemberRoles(hr, hrMember.id, [roleIds.hr_admin, roleIds.recruiter]))).toBe('self_change');
		expect(await code(setMemberStatus(hr, hrMember.id, 'disabled'))).toBe('self_change');
	});

	it('HR admin can manage ordinary staff but not owners or finance', async () => {
		const hr = await actorFor(await member(['hr_admin']));
		const staff = await member([]);
		expect(await code(setMemberRoles(hr, staff.id, [roleIds.recruiter]))).toBe('ok');
		expect(await code(setMemberStatus(hr, staff.id, 'disabled'))).toBe('ok');
		const owner = await member(['owner']);
		expect(await code(setMemberStatus(hr, owner.id, 'disabled'))).toBe('role_not_grantable');
		const finance = await member(['finance']);
		expect(await code(setMemberRoles(hr, finance.id, []))).toBe('role_not_grantable');
	});

	it('a disabled member loses access to the organisation at once', async () => {
		const owner = await actorFor(await member(['owner']));
		const staff = await member([]);
		expect(await resolveTenantAccess(tenant.slug, staff.userId)).not.toBeNull();
		await setMemberStatus(owner, staff.id, 'disabled');
		expect(await resolveTenantAccess(tenant.slug, staff.userId)).toBeNull();
	});

	it('two owners removing each other at once cannot leave the organisation without an owner', async () => {
		const own = await createTenant('owners');
		await withTenant(systemCtx(own.id), (tx) => seedTenant(tx, own.id));
		const mk = async () => {
			const u = await createUser();
			const id = await withTenant(systemCtx(own.id), (tx) => addMember(tx, own.id, u.id, ['owner']));
			const actor: Actor = {
				ctx: { tenantId: own.id, userId: u.id, actor: 'user' },
				tenant: { id: own.id, slug: own.slug, name: own.slug },
				access: await loadAccess(own.id, { id, status: 'active', employeeId: null })
			};
			return { id, actor };
		};
		const a = await mk();
		const b = await mk();
		const results = await Promise.all([
			code(setMemberRoles(a.actor, b.id, [])),
			code(setMemberRoles(b.actor, a.id, []))
		]);
		expect(results.sort()).toEqual(['last_owner', 'ok']);
	});

	it('an invitation dies when its inviter loses roles or access', async () => {
		const owner = await actorFor(await member(['owner']));
		const hrMember = await member(['hr_admin']);
		const hr = await actorFor(hrMember);
		await inviteMember(hr, { email: 'pending@members.test', roleIds: [roleIds.recruiter] });
		await setMemberRoles(owner, hrMember.id, []);
		const open = await withTenant(systemCtx(tenant.id), (tx) =>
			tx
				.select()
				.from(invitations)
				.where(and(eq(invitations.email, 'pending@members.test'), isNull(invitations.revokedAt)))
		);
		expect(open).toEqual([]);

		const inviter = await member(['hr_admin']);
		const { token } = await withTenant(systemCtx(tenant.id), (tx) =>
			createInvitation(tx, {
				tenantId: tenant.id,
				email: 'late@members.test',
				roleIds: [],
				invitedByMembershipId: inviter.id
			})
		);
		await setMemberStatus(owner, inviter.id, 'disabled');
		await withTenant(systemCtx(tenant.id), (tx) =>
			tx
				.update(invitations)
				.set({ revokedAt: null })
				.where(eq(invitations.tokenHash, sha256(token)))
		);
		const joiner = await createUser('late@members.test');
		await expect(authPool().sql`select auth_accept_invitation(${sha256(token)}, ${joiner.id})`).rejects.toThrow(
			'invitation_invalid'
		);
	});

	it('leaves no account behind when registering from an invitation that can no longer be accepted', async () => {
		const owner = await actorFor(await member(['owner']));
		const inviter = await member(['hr_admin']);
		const email = 'stale@members.test';
		const { token } = await withTenant(systemCtx(tenant.id), (tx) =>
			createInvitation(tx, { tenantId: tenant.id, email, roleIds: [], invitedByMembershipId: inviter.id })
		);
		await setMemberStatus(owner, inviter.id, 'disabled');
		await withTenant(systemCtx(tenant.id), (tx) =>
			tx
				.update(invitations)
				.set({ revokedAt: null })
				.where(eq(invitations.tokenHash, sha256(token)))
		);
		expect(
			await code(
				registerFromInvitation(token, { name: 'Stale', password: 'correct horse battery staple' }, { ip: '10.1.1.1' })
			)
		).toBe('invitation_invalid');
		expect(await findUserByEmail(email)).toBeUndefined();
	});
});

describe('linking members to employee records', () => {
	let n = 0;
	const employee = async (status = 'active') => {
		n += 1;
		const [e] = await withTenant(systemCtx(tenant.id), (tx) =>
			tx
				.insert(employees)
				.values({
					tenantId: tenant.id,
					code: `LNK-${n}`,
					fullName: `Linked ${n}`,
					employmentType: 'full_time',
					status: status as 'active',
					joinDate: '2026-01-05'
				})
				.returning({ id: employees.id })
		);
		return e.id;
	};
	const linkedTo = async (membershipId: string) => {
		const [m] = await withTenant(systemCtx(tenant.id), (tx) =>
			tx.select({ employeeId: memberships.employeeId }).from(memberships).where(eq(memberships.id, membershipId))
		);
		return m.employeeId;
	};

	it('HR links and unlinks a member; one record belongs to one member', async () => {
		const hr = await actorFor(await member(['hr_admin']));
		const a = await member([]);
		const b = await member([]);
		const rec = await employee();
		expect(await code(linkEmployee(hr, a.id, rec))).toBe('ok');
		expect((await resolveTenantAccess(tenant.slug, a.userId))!.membership.employeeId).toBe(rec);
		expect(await code(linkEmployee(hr, b.id, rec))).toBe('employee_taken');
		expect(await code(linkEmployee(hr, a.id, null))).toBe('ok');
		expect(await linkedTo(a.id)).toBeNull();
		expect(await code(linkEmployee(hr, b.id, rec))).toBe('ok');
	});

	it('refuses self-links, exited records, unknown ids and records outside the actor scope', async () => {
		const hrMember = await member(['hr_admin']);
		const hr = await actorFor(hrMember);
		const staff = await member([]);
		expect(await code(linkEmployee(hr, hrMember.id, await employee()))).toBe('self_change');
		expect(await code(linkEmployee(hr, staff.id, await employee('exited')))).toBe('employee_exited');
		expect(await code(linkEmployee(hr, staff.id, crypto.randomUUID()))).toBe('employee_not_found');
		expect(await code(linkEmployee(hr, staff.id, 'nope'))).not.toBe('ok');
		const usersOnly: Actor = { ...hr, access: { ...hr.access, grants: { 'user.manage': ['all'] } } };
		expect(await code(linkEmployee(usersOnly, staff.id, await employee()))).toBe('out_of_scope');
		expect(await linkedTo(staff.id)).toBeNull();
	});

	it('an invitation carries the employee record into the new membership', async () => {
		const owner = await actorFor(await member(['owner']));
		const rec = await employee();
		await inviteMember(owner, { email: 'linked@members.test', roleIds: [], employeeId: rec });
		const [inv] = await withTenant(systemCtx(tenant.id), (tx) =>
			tx
				.select({ employeeId: invitations.employeeId })
				.from(invitations)
				.where(and(eq(invitations.email, 'linked@members.test'), isNull(invitations.revokedAt)))
		);
		expect(inv.employeeId).toBe(rec);
		const other = await member([]);
		await linkEmployee(owner, other.id, rec);
		const open = await withTenant(systemCtx(tenant.id), (tx) =>
			tx
				.select()
				.from(invitations)
				.where(and(eq(invitations.email, 'linked@members.test'), isNull(invitations.revokedAt)))
		);
		expect(open).toEqual([]);
	});
});
