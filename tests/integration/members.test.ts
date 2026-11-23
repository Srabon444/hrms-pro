import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authPool, closePools } from '../../src/lib/server/db';
import { invitations } from '../../src/lib/server/db/schema';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess } from '../../src/lib/server/rbac/access';
import { inviteMember, setMemberRoles, setMemberStatus, type Actor } from '../../src/lib/server/rbac/members';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { resolveTenantAccess } from '../../src/lib/server/tenancy/resolve';
import { createInvitation } from '../../src/lib/server/invitations';
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
		const token = await withTenant(systemCtx(tenant.id), (tx) =>
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
});
