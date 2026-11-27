import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { covers, type GrantMap } from '../rbac/grants';
import { isScopeValue, type Permission, type Scope } from '../rbac/permissions';
import { auditEvent } from './audit';
import { randomToken, sha256 } from './auth/crypto';
import { requireRecentAuth } from './auth/session';
import { now } from './clock';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { apiKeys } from './db/schema';
import { AppError } from './errors';
import { can, userCtx, type requireMember } from './rbac/access';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const API_GRANTABLE = [
	'employee.read',
	'leave.read',
	'attendance.read',
	'schedule.read',
	'calendar.read'
] as const satisfies readonly Permission[];
export const API_KEY_DAYS = [30, 90, 180, 365] as const;
export const API_REAUTH_MINUTES = 10;
export const API_KEY = /^hrp_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

const keySchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, 'Enter a name.')
		.max(60, 'Keep the name under 60 characters.')
		.regex(/^[^\p{Cc}]+$/u, 'Use letters, numbers and spaces in the name.'),
	days: z.coerce.number().refine((d) => (API_KEY_DAYS as readonly number[]).includes(d), 'Pick how long the key works.')
});

export function keyGrants(raw: Record<string, string>, held: GrantMap): Record<string, Scope> {
	const grants: Record<string, Scope> = {};
	for (const p of API_GRANTABLE) {
		const scope = raw[`grant.${p}`] ?? '';
		if (!scope) continue;
		if (!isScopeValue(scope) || !covers(held[p], scope))
			throw new AppError('forbidden', 'A key can only read what you can read yourself.', 403);
		grants[p] = scope;
	}
	if (!Object.keys(grants).length) throw new AppError('invalid', 'Pick at least one thing the key can read.', 400);
	return grants;
}

export function effectiveGrants(key: Record<string, string>, creator: GrantMap): GrantMap {
	const out: GrantMap = {};
	for (const p of API_GRANTABLE) {
		const scope = key[p];
		if (!scope || !isScopeValue(scope)) continue;
		const held = creator[p] ?? [];
		const scopes = covers(held, scope) ? [scope] : held.filter((s) => covers([scope], s));
		if (scopes.length) out[p] = scopes;
	}
	return out;
}

export async function createApiKey(m: Member, raw: Record<string, string>): Promise<string> {
	if (!can(m.access, 'api.manage')) throw new AppError('forbidden', 'You cannot make API keys.', 403);
	await requireRecentAuth(m.user.sessionId, API_REAUTH_MINUTES);
	const input = keySchema.parse(raw);
	const grants = keyGrants(raw, m.access.grants);
	const prefix = randomBytes(4).toString('hex');
	const key = `hrp_${prefix}_${randomToken()}`;
	const t = now();
	await withTenant(userCtx(m), async (tx) => {
		const [row] = await tx
			.insert(apiKeys)
			.values({
				tenantId: m.tenant.id,
				name: input.name,
				prefix,
				keyHash: sha256(key),
				grants,
				createdByMembershipId: m.access.membershipId,
				createdAt: t,
				expiresAt: new Date(t.getTime() + input.days * 86_400_000)
			})
			.returning({ id: apiKeys.id })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError(
						'duplicate',
						'A key with that name already exists, even if it was revoked. Pick another name.',
						409
					);
				throw err;
			});
		await auditEvent(tx, userCtx(m), 'api_keys', row.id, 'api_key.create', { name: input.name });
	});
	return key;
}

export const listApiKeys = (tx: Tx) =>
	tx
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			prefix: apiKeys.prefix,
			grants: apiKeys.grants,
			createdBy: sql<string>`(select tu.name from tenant_users tu where tu.membership_id = ${apiKeys.createdByMembershipId})`,
			createdAt: apiKeys.createdAt,
			expiresAt: apiKeys.expiresAt,
			lastUsedAt: apiKeys.lastUsedAt,
			revokedAt: apiKeys.revokedAt,
			expired: sql<boolean>`${apiKeys.expiresAt} <= now()`
		})
		.from(apiKeys)
		.orderBy(desc(apiKeys.createdAt));

export async function revokeApiKey(ctx: TenantCtx, rawId: string): Promise<void> {
	const id = z.uuid().safeParse(rawId);
	await withTenant(ctx, async (tx) => {
		const [row] = id.success
			? await tx
					.update(apiKeys)
					.set({ revokedAt: now() })
					.where(and(eq(apiKeys.id, id.data), isNull(apiKeys.revokedAt)))
					.returning({ id: apiKeys.id })
			: [];
		if (!row) throw new AppError('not_found', 'That key does not exist or is already revoked.', 404);
		await auditEvent(tx, ctx, 'api_keys', row.id, 'api_key.revoke');
	});
}
