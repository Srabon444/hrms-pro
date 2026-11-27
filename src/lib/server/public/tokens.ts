import { eq } from 'drizzle-orm';
import { authPool } from '../db';
import { tenants } from '../db/schema';

export type TokenKind = 'calendar_feed' | 'kiosk_device' | 'kiosk_pair';

export type TokenHolder = {
	tenantId: string;
	tenantName: string;
	tokenId: string;
	membershipId: string;
	userId: string;
	employeeId: string | null;
};

export async function lookupToken(kind: TokenKind, hash: string): Promise<{ tenantId: string; id: string } | null> {
	const [row] = await authPool().sql<{ tenant_id: string; id: string }[]>`
		select tenant_id, id from public.public_token_lookup(${kind}, ${hash})`;
	return row ? { tenantId: row.tenant_id, id: row.id } : null;
}

export async function activeHolder(
	token: { tenantId: string; id: string },
	membershipId: string
): Promise<TokenHolder | null> {
	const [row] = await authPool().sql<{ name: string; user_id: string; employee_id: string | null }[]>`
		select t.name, m.user_id, m.employee_id
		from public.memberships m
		join public.users u on u.id = m.user_id
		join public.tenants t on t.id = m.tenant_id
		where m.id = ${membershipId} and m.tenant_id = ${token.tenantId}
			and m.status = 'active' and u.status = 'active' and t.status = 'active'`;
	return row
		? {
				tenantId: token.tenantId,
				tenantName: row.name,
				tokenId: token.id,
				membershipId,
				userId: row.user_id,
				employeeId: row.employee_id
			}
		: null;
}

export async function revokeUserFeeds(userId: string): Promise<void> {
	await authPool().sql`select public.revoke_user_calendar_feeds(${userId})`;
}

export async function activeTenant(tenantId: string) {
	const [t] = await authPool()
		.db.select({ name: tenants.name, slug: tenants.slug, status: tenants.status })
		.from(tenants)
		.where(eq(tenants.id, tenantId));
	return t?.status === 'active' ? t : null;
}
