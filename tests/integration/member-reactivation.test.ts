import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInvitation } from '../../src/lib/server/auth/service';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { invitations } from '../../src/lib/server/db/schema';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess } from '../../src/lib/server/rbac/access';
import { inviteMember, setMemberStatus, type Actor } from '../../src/lib/server/rbac/members';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

let tenant: { id: string; slug: string };

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

async function accept(email: string, userId: string) {
	const [inv] = await withTenant(systemCtx(tenant.id), (tx) =>
		tx
			.select({ id: invitations.id })
			.from(invitations)
			.where(and(eq(invitations.email, email), isNull(invitations.revokedAt)))
	);
	const token = `tok-${inv.id}`;
	await ownerPool().sql`update invitations set token_hash = ${sha256(token)} where id = ${inv.id}`;
	return code(acceptInvitation(token, userId));
}
const statusOf = async (id: string) =>
	(await ownerPool().sql`select status from memberships where id = ${id}`)[0].status;

beforeAll(async () => {
	tenant = await createTenant('member-reactivation');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
});
afterAll(closePools);

describe('re-inviting a member who is not active', () => {
	for (const roleKey of ['finance', 'owner', 'payroll_officer']) {
		it(`does not let an HR admin re-enable a disabled ${roleKey}`, async () => {
			const owner = await actorFor(await member(['owner']));
			const hr = await actorFor(await member(['hr_admin']));
			const target = await member([roleKey]);
			await setMemberStatus(owner, target.id, 'disabled');
			expect(await code(inviteMember(hr, { email: target.email, roleIds: [] }))).toBe('role_not_grantable');
			expect(await statusOf(target.id)).toBe('disabled');
		});
	}

	it('lets an owner re-invite a disabled finance member', async () => {
		const owner = await actorFor(await member(['owner']));
		const target = await member(['finance']);
		await setMemberStatus(owner, target.id, 'disabled');
		expect(await code(inviteMember(owner, { email: target.email, roleIds: [] }))).toBe('ok');
		expect(await accept(target.email, target.userId)).toBe('ok');
		expect(await statusOf(target.id)).toBe('active');
	});

	it('refuses to invite a former employee', async () => {
		const hr = await actorFor(await member(['hr_admin']));
		const target = await member([]);
		await ownerPool().sql`update memberships set status = 'ex_employee' where id = ${target.id}`;
		expect(await code(inviteMember(hr, { email: target.email, roleIds: [] }))).toBe('ex_employee');
	});

	it('does not reactivate someone who left after the invitation was sent', async () => {
		const owner = await actorFor(await member(['owner']));
		const target = await member([]);
		await setMemberStatus(owner, target.id, 'disabled');
		await inviteMember(owner, { email: target.email, roleIds: [] });
		await ownerPool().sql`update memberships set status = 'ex_employee' where id = ${target.id}`;
		expect(await accept(target.email, target.userId)).toBe('invitation_invalid');
		expect(await statusOf(target.id)).toBe('ex_employee');
	});

	it('refuses an invitation to a suspended organisation', async () => {
		const owner = await actorFor(await member(['owner']));
		const u = await createUser();
		await inviteMember(owner, { email: u.email, roleIds: [] });
		await ownerPool().sql`update tenants set status = 'suspended' where id = ${tenant.id}`;
		try {
			expect(await accept(u.email, u.id)).toBe('invitation_invalid');
		} finally {
			await ownerPool().sql`update tenants set status = 'active' where id = ${tenant.id}`;
		}
	});
});
