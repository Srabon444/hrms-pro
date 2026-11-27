import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditEvent } from '../audit';
import { sha256 } from '../auth/crypto';
import { deleteSsoSessions } from '../auth/session';
import { emailSchema, findUserByEmail } from '../auth/users';
import { config } from '../config';
import { authPool } from '../db';
import { membershipRoles, memberships, roles, ssoDomains, users } from '../db/schema';
import { AppError } from '../errors';
import { advisoryLock, LOCK } from '../locks';
import { log } from '../log';
import { addMember } from '../platform/tenants';
import { hitOrLocal, overLimit } from '../ratelimit';
import { revokeInvitesBy } from '../rbac/members';
import { SSO_PASSWORD_SENTINEL } from '../sso';
import { systemCtx, withTenant, type Tx } from '../tenancy';
import { activeTenant, lookupToken } from './tokens';

export const SCIM_TOKEN = /^hrs_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
export const SCIM_PER_MIN = 600;
export const SCIM_BODY_MAX = 64 * 1024;
export const SCIM_PAGE_MAX = 100;
const AUTH_FAILS_PER_IP_HOUR = 30;
const HOUR = 3_600_000;

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

const HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/scim+json; charset=utf-8' };
const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
	new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const scimError = (status: number, detail: string, scimType?: string, extra: Record<string, string> = {}) =>
	reply(status, { schemas: [ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) }, extra);

class ScimError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly scimType?: string
	) {
		super(message);
	}
}

const base = () => new URL('/api/scim/v2', config().APP_URL).toString();
const missing = () => new ScimError(404, 'That user does not exist here.');

type Ctx = { tenantId: string; connectionId: string };
type Row = { id: string; email: string; status: string; createdAt: Date; updatedAt: Date };

const view = (r: Row) => ({
	schemas: [USER],
	id: r.id,
	userName: r.email,
	emails: [{ value: r.email, type: 'work', primary: true }],
	active: r.status === 'active',
	meta: {
		resourceType: 'User',
		created: r.createdAt.toISOString(),
		lastModified: r.updatedAt.toISOString(),
		location: `${base()}/Users/${r.id}`
	}
});

const rows = (tx: Tx, where?: ReturnType<typeof sql>, page = sql``) =>
	tx.execute<{ id: string; email: string; status: string; created_at: string; updated_at: string }>(sql`
		select m.id, tu.email, m.status, m.created_at, m.updated_at
		from tenant_users tu join memberships m on m.id = tu.membership_id
		${where ? sql`where ${where}` : sql``}
		order by m.created_at, m.id ${page}`);

const toRow = (r: { id: string; email: string; status: string; created_at: string; updated_at: string }): Row => ({
	id: r.id,
	email: r.email,
	status: r.status,
	createdAt: new Date(r.created_at),
	updatedAt: new Date(r.updated_at)
});

async function one(tx: Tx, id: string): Promise<Row> {
	if (!z.uuid().safeParse(id).success) throw missing();
	const [r] = await rows(tx, sql`m.id = ${id}`);
	if (!r) throw missing();
	return toRow(r);
}

export const FILTER = /^\s*userName\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;
const listQuery = z.object({
	startIndex: z.coerce
		.number()
		.int()
		.catch(1)
		.transform((n) => Math.max(1, n)),
	count: z.coerce
		.number()
		.int()
		.catch(SCIM_PAGE_MAX)
		.transform((n) => Math.min(SCIM_PAGE_MAX, Math.max(0, n)))
});

async function listUsers(ctx: Ctx, url: URL) {
	const q = listQuery.parse({
		startIndex: url.searchParams.get('startIndex') ?? 1,
		count: url.searchParams.get('count') ?? SCIM_PAGE_MAX
	});
	const filter = url.searchParams.get('filter');
	let where: ReturnType<typeof sql> | undefined;
	if (filter !== null) {
		const m = FILTER.exec(filter);
		if (!m) throw new ScimError(400, 'Only filter=userName eq "<email>" is supported.', 'invalidFilter');
		const email = emailSchema.safeParse(m[1].replace(/\\(.)/g, '$1'));
		if (!email.success)
			return reply(200, { schemas: [LIST], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
		where = sql`tu.email = ${email.data}`;
	}
	const { total, page } = await withTenant(systemCtx(ctx.tenantId), async (tx) => {
		const [{ n }] = await tx.execute<{ n: number }>(sql`
			select count(*)::int as n from tenant_users tu ${where ? sql`where ${where}` : sql``}`);
		const found = await rows(tx, where, sql`limit ${q.count} offset ${q.startIndex - 1}`);
		return { total: n, page: found.map(toRow) };
	});
	return reply(200, {
		schemas: [LIST],
		totalResults: total,
		startIndex: q.startIndex,
		itemsPerPage: page.length,
		Resources: page.map(view)
	});
}

const flag = z.union([
	z.boolean(),
	z
		.string()
		.trim()
		.toLowerCase()
		.pipe(z.enum(['true', 'false']))
		.transform((v) => v === 'true')
]);

const newUser = z.object({
	userName: emailSchema,
	active: flag.optional().default(true),
	displayName: z.string().optional(),
	name: z
		.object({ formatted: z.string().optional(), givenName: z.string().optional(), familyName: z.string().optional() })
		.partial()
		.optional()
});

const cleanName = (input: z.infer<typeof newUser>) => {
	const raw =
		input.displayName ||
		input.name?.formatted ||
		[input.name?.givenName, input.name?.familyName].filter(Boolean).join(' ') ||
		input.userName.split('@')[0];
	return (
		raw
			.replace(/\p{Cc}/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 120) || input.userName.split('@')[0]
	);
};

async function globalUser(email: string, name: string) {
	const existing = await findUserByEmail(email);
	if (existing) return existing.id;
	const [created] = await authPool()
		.db.insert(users)
		.values({ email, name, passwordHash: SSO_PASSWORD_SENTINEL })
		.onConflictDoNothing({ target: users.email })
		.returning({ id: users.id });
	return created?.id ?? (await findUserByEmail(email))!.id;
}

async function createUser(ctx: Ctx, body: unknown) {
	const parsed = newUser.safeParse(body);
	if (!parsed.success) throw new ScimError(400, 'userName must be an email address.', 'invalidValue');
	const input = parsed.data;
	const domain = input.userName.split('@')[1];
	const ok = await withTenant(systemCtx(ctx.tenantId), (tx) =>
		tx
			.select({ id: ssoDomains.id })
			.from(ssoDomains)
			.where(
				and(
					eq(ssoDomains.domain, domain),
					eq(ssoDomains.connectionId, ctx.connectionId),
					isNotNull(ssoDomains.verifiedAt)
				)
			)
	);
	if (!ok.length)
		throw new ScimError(400, "userName must be in one of the organisation's verified domains.", 'invalidValue');
	const [already] = await withTenant(systemCtx(ctx.tenantId), (tx) => rows(tx, sql`tu.email = ${input.userName}`));
	if (already) throw new ScimError(409, 'That user already exists here.', 'uniqueness');
	const userId = await globalUser(input.userName, cleanName(input));
	const sys = systemCtx(ctx.tenantId);
	const row = await withTenant(sys, async (tx) => {
		await advisoryLock(tx, LOCK.scim, `${ctx.tenantId}:${userId}`);
		const [taken] = await tx
			.select({ id: memberships.id })
			.from(memberships)
			.where(eq(memberships.userId, userId))
			.for('update');
		if (taken) throw new ScimError(409, 'That user already exists here.', 'uniqueness');
		const id = await addMember(tx, ctx.tenantId, userId, []);
		if (!input.active)
			await tx.update(memberships).set({ status: 'disabled', disabledBy: 'scim' }).where(eq(memberships.id, id));
		await auditEvent(tx, sys, 'memberships', id, 'scim.create', { email: input.userName });
		return one(tx, id);
	});
	return reply(201, view(row), { location: `${base()}/Users/${row.id}` });
}

async function setActive(ctx: Ctx, id: string, want: boolean | undefined) {
	const sys = systemCtx(ctx.tenantId);
	const { row, userId } = await withTenant(sys, async (tx) => {
		await one(tx, id);
		const [m] = await tx
			.select({ status: memberships.status, disabledBy: memberships.disabledBy, userId: memberships.userId })
			.from(memberships)
			.where(eq(memberships.id, id))
			.for('update');
		if (want === false) {
			const [owner] = await tx
				.select({ id: membershipRoles.id })
				.from(membershipRoles)
				.innerJoin(roles, eq(roles.id, membershipRoles.roleId))
				.where(and(eq(membershipRoles.membershipId, id), eq(roles.key, 'owner')));
			if (owner) throw new ScimError(400, 'Owners are managed in the app, not by provisioning.', 'mutability');
			if (m.status === 'active') {
				await tx.update(memberships).set({ status: 'disabled', disabledBy: 'scim' }).where(eq(memberships.id, id));
				await revokeInvitesBy(tx, id);
				await auditEvent(tx, sys, 'memberships', id, 'scim.deactivate');
			}
			return { row: await one(tx, id), userId: m.userId };
		}
		if (want === true && m.status === 'disabled' && m.disabledBy === 'scim') {
			await tx.update(memberships).set({ status: 'active', disabledBy: null }).where(eq(memberships.id, id));
			await auditEvent(tx, sys, 'memberships', id, 'scim.reactivate');
			return { row: await one(tx, id), userId: null };
		}
		return { row: await one(tx, id), userId: null };
	});
	if (userId) await deleteSsoSessions(ctx.tenantId, userId);
	return row;
}

const putBody = z.object({ active: flag.optional() }).loose();
const patchBody = z.object({
	schemas: z.array(z.string()).refine((s) => s.includes(PATCH), 'Send a PatchOp.'),
	Operations: z
		.array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown().optional() }))
		.min(1)
		.max(50)
});

export function patchActive(body: unknown): boolean | undefined {
	const parsed = patchBody.safeParse(body);
	if (!parsed.success) throw new ScimError(400, 'Send a PatchOp with at least one operation.', 'invalidSyntax');
	let want: boolean | undefined;
	for (const op of parsed.data.Operations) {
		if (!['replace', 'add'].includes(op.op.toLowerCase())) continue;
		const value =
			op.path?.toLowerCase() === 'active'
				? op.value
				: !op.path && op.value && typeof op.value === 'object'
					? Object.entries(op.value).find(([k]) => k.toLowerCase() === 'active')?.[1]
					: undefined;
		if (value === undefined) continue;
		const f = flag.safeParse(value);
		if (!f.success) throw new ScimError(400, 'active must be true or false.', 'invalidValue');
		want = f.data;
	}
	return want;
}

const SERVICE_CONFIG = () => ({
	schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
	patch: { supported: true },
	bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
	filter: { supported: true, maxResults: SCIM_PAGE_MAX },
	changePassword: { supported: false },
	sort: { supported: false },
	etag: { supported: false },
	authenticationSchemes: [
		{
			type: 'oauthbearertoken',
			name: 'Bearer token',
			description: 'The provisioning token from Settings → Company sign-in.'
		}
	],
	meta: { resourceType: 'ServiceProviderConfig', location: `${base()}/ServiceProviderConfig` }
});

const USER_SCHEMA = () => ({
	schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
	id: USER,
	name: 'User',
	attributes: [
		{
			name: 'userName',
			type: 'string',
			multiValued: false,
			required: true,
			caseExact: false,
			mutability: 'immutable',
			returned: 'default',
			uniqueness: 'server'
		},
		{
			name: 'active',
			type: 'boolean',
			multiValued: false,
			required: false,
			mutability: 'readWrite',
			returned: 'default'
		}
	],
	meta: { resourceType: 'Schema', location: `${base()}/Schemas/${USER}` }
});

const RESOURCE_TYPE = () => ({
	schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
	id: 'User',
	name: 'User',
	endpoint: '/Users',
	schema: USER,
	meta: { resourceType: 'ResourceType', location: `${base()}/ResourceTypes/User` }
});

const listOf = (items: unknown[]) => ({
	schemas: [LIST],
	totalResults: items.length,
	startIndex: 1,
	itemsPerPage: items.length,
	Resources: items
});

const jsonType = (request: Request) => {
	const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
	return type === 'application/scim+json' || type === 'application/json';
};

async function readBody(request: Request): Promise<unknown> {
	if (!jsonType(request)) throw new ScimError(415, 'Send application/scim+json.');
	if (Number(request.headers.get('content-length') ?? 0) > SCIM_BODY_MAX)
		throw new ScimError(413, 'Send at most 64 KB.');
	const text = await request.text();
	if (Buffer.byteLength(text) > SCIM_BODY_MAX) throw new ScimError(413, 'Send at most 64 KB.');
	try {
		return JSON.parse(text);
	} catch {
		throw new ScimError(400, 'The body is not valid JSON.', 'invalidSyntax');
	}
}

async function route(ctx: Ctx, request: Request, parts: string[], url: URL): Promise<Response> {
	const method = request.method;
	const [head, id, ...rest] = parts;
	if (rest.length) throw new ScimError(404, 'Not found.');
	if (head === 'ServiceProviderConfig' && !id && method === 'GET') return reply(200, SERVICE_CONFIG());
	if (head === 'Schemas' && method === 'GET') {
		if (!id) return reply(200, listOf([USER_SCHEMA()]));
		if (id === USER) return reply(200, USER_SCHEMA());
		throw new ScimError(404, 'Not found.');
	}
	if (head === 'ResourceTypes' && method === 'GET') {
		if (!id) return reply(200, listOf([RESOURCE_TYPE()]));
		if (id === 'User') return reply(200, RESOURCE_TYPE());
		throw new ScimError(404, 'Not found.');
	}
	if (head !== 'Users') throw new ScimError(404, 'Only Users are provisioned.');
	if (!id) {
		if (method === 'GET') return listUsers(ctx, url);
		if (method === 'POST') return createUser(ctx, await readBody(request));
		throw new ScimError(405, 'Use GET or POST on /Users.');
	}
	if (method === 'GET') return reply(200, view(await withTenant(systemCtx(ctx.tenantId), (tx) => one(tx, id))));
	if (method === 'PUT') {
		const body = putBody.safeParse(await readBody(request));
		if (!body.success) throw new ScimError(400, 'active must be true or false.', 'invalidValue');
		return reply(200, view(await setActive(ctx, id, body.data.active)));
	}
	if (method === 'PATCH') return reply(200, view(await setActive(ctx, id, patchActive(await readBody(request)))));
	if (method === 'DELETE') {
		await setActive(ctx, id, false);
		return reply(204, null);
	}
	throw new ScimError(405, 'That method is not supported here.');
}

export async function scimRequest(request: Request, path: string, ip: string): Promise<Response> {
	const failed = async () => {
		if (await overLimit('scim-auth-fail', ip, AUTH_FAILS_PER_IP_HOUR))
			return scimError(429, 'Too many failed attempts.', undefined, { 'retry-after': String(HOUR / 1000) });
		await hitOrLocal('scim-auth-fail', ip, AUTH_FAILS_PER_IP_HOUR, HOUR);
		return scimError(401, 'Send the provisioning token as Authorization: Bearer <token>.', undefined, {
			'www-authenticate': 'Bearer'
		});
	};
	const token = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
	if (!SCIM_TOKEN.test(token)) return failed();
	const found = await lookupToken('scim', sha256(token));
	if (!found || !(await activeTenant(found.tenantId))) return failed();
	const limited = await hitOrLocal('scim', found.id, SCIM_PER_MIN, 60_000);
	if (!limited.ok)
		return scimError(429, 'Too many requests.', undefined, { 'retry-after': String(limited.retryAfter) });
	const ctx = { tenantId: found.tenantId, connectionId: found.id };
	try {
		return await route(ctx, request, path.split('/').filter(Boolean), new URL(request.url));
	} catch (err) {
		if (err instanceof ScimError) return scimError(err.status, err.message, err.scimType);
		if (err instanceof AppError) return scimError(err.status, err.message);
		log.error({ err, tenantId: found.tenantId }, 'scim request failed');
		return scimError(500, 'Something went wrong.');
	}
}
