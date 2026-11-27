import { and, asc, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { ModuleId } from '../../modules';
import type { Permission } from '../../rbac/permissions';
import { API_KEY, effectiveGrants } from '../api-keys';
import { DEVICE_KEY, ingestPunches } from '../attendance-devices';
import { auditEvent } from '../audit';
import { sha256 } from '../auth/crypto';
import { now } from '../clock';
import {
	apiKeys,
	attendanceDays,
	departments,
	designations,
	employees,
	events,
	leaveRequests,
	leaveTypes,
	rosterEntries,
	shifts
} from '../db/schema';
import { AppError } from '../errors';
import { eventFields, visibleTo } from '../events';
import { log } from '../log';
import { modulesOn } from '../modules';
import { hitOrLocal, overLimit } from '../ratelimit';
import { readAccess, type Access } from '../rbac/access';
import { resolveScope, scopeWhere } from '../rbac/scope';
import { systemCtx, withTenant, type TenantCtx, type Tx } from '../tenancy';
import { OPENAPI } from './openapi';
import { activeHolder, activeTenant, lookupToken } from './tokens';

const HOUR = 3_600_000;
export const API_PER_KEY_MIN = 600;
export const API_AUTH_FAILS_PER_IP_HOUR = 30;
export const API_PAGE_MAX = 200;
export const DEVICE_PER_MIN = 60;
export const DEVICE_BODY_MAX = 256 * 1024;
const MAX_SPAN_DAYS = 366;

const HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };

const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const problem = (status: number, error: string, message: string, extra: Record<string, string> = {}) =>
	reply(status, { error, message }, extra);

const page = z.object({
	limit: z.coerce
		.number()
		.int(`limit must be a whole number from 1 to ${API_PAGE_MAX}.`)
		.min(1, `limit must be a whole number from 1 to ${API_PAGE_MAX}.`)
		.max(API_PAGE_MAX, `limit must be a whole number from 1 to ${API_PAGE_MAX}.`)
		.default(50),
	cursor: z.uuid().optional()
});
const range = page
	.extend({ from: z.iso.date(), to: z.iso.date() })
	.refine((q) => q.from <= q.to, 'from must be on or before to.')
	.refine(
		(q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_SPAN_DAYS,
		`Ask for at most ${MAX_SPAN_DAYS} days at a time.`
	);

type Ctx = { tx: Tx; access: Access; id: string; params: Record<string, string> };

const after = (column: PgColumn, cursor: string | undefined) => (cursor ? gt(column, cursor) : undefined);

function paged<T extends { id: string }>(rows: T[], limit: number) {
	const data = rows.slice(0, limit);
	return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
}

const employeeFields = {
	id: employees.id,
	code: employees.code,
	fullName: employees.fullName,
	workEmail: employees.workEmail,
	department: departments.name,
	designation: designations.name,
	managerId: employees.managerId,
	branchId: employees.branchId,
	employmentType: employees.employmentType,
	joinDate: employees.joinDate,
	status: employees.status,
	exitDate: employees.exitDate
};

const employeeRows = (tx: Tx, where: SQL | undefined) =>
	tx
		.select(employeeFields)
		.from(employees)
		.leftJoin(departments, eq(departments.id, employees.departmentId))
		.leftJoin(designations, eq(designations.id, employees.designationId))
		.where(where);

type Endpoint = { path: RegExp; perm: Permission; module?: ModuleId; run: (c: Ctx) => Promise<unknown> };

const ENDPOINTS: Endpoint[] = [
	{
		path: /^employees$/,
		perm: 'employee.read',
		run: async ({ tx, access, params }) => {
			const q = page.parse(params);
			const scope = await resolveScope(tx, access, 'employee.read');
			const rows = await employeeRows(tx, and(scopeWhere(scope, employees.id), after(employees.id, q.cursor)))
				.orderBy(asc(employees.id))
				.limit(q.limit + 1);
			return paged(rows, q.limit);
		}
	},
	{
		path: /^employees\/([0-9a-f-]{36})$/,
		perm: 'employee.read',
		run: async ({ tx, access, id }) => {
			const scope = await resolveScope(tx, access, 'employee.read');
			const [row] = z.uuid().safeParse(id).success
				? await employeeRows(tx, and(scopeWhere(scope, employees.id), eq(employees.id, id)))
				: [];
			if (!row) throw new AppError('not_found', 'No such employee.', 404);
			return { data: row };
		}
	},
	{
		path: /^leave-requests$/,
		perm: 'leave.read',
		run: async ({ tx, access, params }) => {
			const q = range.parse(params);
			const scope = await resolveScope(tx, access, 'leave.read');
			const rows = await tx
				.select({
					id: leaveRequests.id,
					employeeId: leaveRequests.employeeId,
					leaveType: leaveTypes.name,
					startDate: leaveRequests.startDate,
					endDate: leaveRequests.endDate,
					session: leaveRequests.session,
					days: leaveRequests.days,
					status: leaveRequests.status,
					decidedAt: leaveRequests.decidedAt
				})
				.from(leaveRequests)
				.innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
				.where(
					and(
						scopeWhere(scope, leaveRequests.employeeId),
						lte(leaveRequests.startDate, q.to),
						gte(leaveRequests.endDate, q.from),
						after(leaveRequests.id, q.cursor)
					)
				)
				.orderBy(asc(leaveRequests.id))
				.limit(q.limit + 1);
			return paged(rows, q.limit);
		}
	},
	{
		path: /^attendance-days$/,
		perm: 'attendance.read',
		run: async ({ tx, access, params }) => {
			const q = range.parse(params);
			const scope = await resolveScope(tx, access, 'attendance.read');
			const rows = await tx
				.select({
					id: attendanceDays.id,
					employeeId: attendanceDays.employeeId,
					date: attendanceDays.date,
					status: attendanceDays.status,
					firstIn: attendanceDays.firstIn,
					lastOut: attendanceDays.lastOut,
					workedMinutes: attendanceDays.workedMinutes,
					lateMinutes: attendanceDays.lateMinutes
				})
				.from(attendanceDays)
				.where(
					and(
						scopeWhere(scope, attendanceDays.employeeId),
						gte(attendanceDays.date, q.from),
						lte(attendanceDays.date, q.to),
						after(attendanceDays.id, q.cursor)
					)
				)
				.orderBy(asc(attendanceDays.id))
				.limit(q.limit + 1);
			return paged(rows, q.limit);
		}
	},
	{
		path: /^roster$/,
		perm: 'schedule.read',
		module: 'schedule',
		run: async ({ tx, access, params }) => {
			const q = range.parse(params);
			const scope = await resolveScope(tx, access, 'schedule.read');
			const rows = await tx
				.select({
					id: rosterEntries.id,
					employeeId: sql<string>`${rosterEntries.employeeId}`,
					date: rosterEntries.date,
					kind: rosterEntries.kind,
					shift: shifts.name,
					startTime: sql<string | null>`to_char(${shifts.startTime}, 'HH24:MI')`,
					endTime: sql<string | null>`to_char(${shifts.endTime}, 'HH24:MI')`
				})
				.from(rosterEntries)
				.leftJoin(shifts, eq(shifts.id, rosterEntries.shiftId))
				.where(
					and(
						isNotNull(rosterEntries.employeeId),
						eq(rosterEntries.status, 'published'),
						scopeWhere(scope, rosterEntries.employeeId),
						gte(rosterEntries.date, q.from),
						lte(rosterEntries.date, q.to),
						after(rosterEntries.id, q.cursor)
					)
				)
				.orderBy(asc(rosterEntries.id))
				.limit(q.limit + 1);
			return paged(rows, q.limit);
		}
	},
	{
		path: /^events$/,
		perm: 'calendar.read',
		module: 'events',
		run: async ({ tx, access, params }) => {
			const q = range.parse(params);
			const rows = await tx
				.select(eventFields)
				.from(events)
				.where(
					and(
						lte(events.startDate, q.to),
						gte(events.endDate, q.from),
						await visibleTo(tx, access),
						after(events.id, q.cursor)
					)
				)
				.orderBy(asc(events.id))
				.limit(q.limit + 1);
			return paged(rows, q.limit);
		}
	}
];

const touch = (ctx: TenantCtx, keyId: string) =>
	withTenant(ctx, async (tx) => {
		const t = now();
		const dayStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
		const [firstToday] = await tx
			.update(apiKeys)
			.set({ lastUsedAt: t })
			.where(and(eq(apiKeys.id, keyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, dayStart))))
			.returning({ id: apiKeys.id });
		if (firstToday) await auditEvent(tx, ctx, 'api_keys', keyId, 'api_key.used');
	});

const unauthorized = () =>
	problem(401, 'unauthorized', 'Send a valid API key as Authorization: Bearer <key>.', {
		'www-authenticate': 'Bearer'
	});

const jsonOnly = (request: Request) => {
	const type = request.headers.get('content-type');
	return !type || type.split(';')[0].trim().toLowerCase() === 'application/json';
};

async function devicePunches(request: Request, ip: string): Promise<Response> {
	if (request.method !== 'POST')
		return problem(405, 'method_not_allowed', 'Send punches with POST.', { allow: 'POST' });
	if (!request.headers.get('content-type') || !jsonOnly(request))
		return problem(415, 'unsupported_media_type', 'Send punches as application/json.');
	const failed = async () => {
		if (await overLimit('api-auth-fail', ip, API_AUTH_FAILS_PER_IP_HOUR))
			return problem(429, 'rate_limited', 'Too many failed attempts.', { 'retry-after': String(HOUR / 1000) });
		await hitOrLocal('api-auth-fail', ip, API_AUTH_FAILS_PER_IP_HOUR, HOUR);
		return problem(401, 'unauthorized', 'Send a valid device key as Authorization: Bearer <key>.', {
			'www-authenticate': 'Bearer'
		});
	};
	const key = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
	if (!DEVICE_KEY.test(key)) return failed();
	const found = await lookupToken('attendance_device', sha256(key));
	if (!found || !(await activeTenant(found.tenantId))) return failed();
	const limited = await hitOrLocal('device', found.id, DEVICE_PER_MIN, 60_000);
	if (!limited.ok)
		return problem(429, 'rate_limited', 'Too many requests for this device.', {
			'retry-after': String(limited.retryAfter)
		});
	if (Number(request.headers.get('content-length') ?? 0) > DEVICE_BODY_MAX)
		return problem(413, 'too_large', 'Send at most 256 KB at a time.');
	const text = await request.text();
	if (Buffer.byteLength(text) > DEVICE_BODY_MAX) return problem(413, 'too_large', 'Send at most 256 KB at a time.');
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return problem(400, 'invalid', 'The body is not valid JSON.');
	}
	try {
		return reply(200, await ingestPunches(found.tenantId, found.id, body));
	} catch (err) {
		if (err instanceof z.ZodError) return problem(400, 'invalid', err.issues[0].message);
		if (err instanceof AppError) return problem(err.status, err.code, err.message);
		log.error({ err, tenantId: found.tenantId, device: found.id }, 'device punches failed');
		return problem(500, 'server_error', 'Something went wrong.');
	}
}

export async function apiRequest(request: Request, path: string, ip: string): Promise<Response> {
	if (path === 'punches') return devicePunches(request, ip);
	if (request.method !== 'GET') return problem(405, 'method_not_allowed', 'This API is read only.', { allow: 'GET' });
	if (!jsonOnly(request)) return problem(415, 'unsupported_media_type', 'This API only speaks JSON.');
	if (path === 'openapi.json') return reply(200, OPENAPI);
	if (await overLimit('api-auth-fail', ip, API_AUTH_FAILS_PER_IP_HOUR))
		return problem(429, 'rate_limited', 'Too many failed attempts.', { 'retry-after': String(HOUR / 1000) });
	const failed = async () => {
		await hitOrLocal('api-auth-fail', ip, API_AUTH_FAILS_PER_IP_HOUR, HOUR);
		return unauthorized();
	};
	const key = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
	if (!API_KEY.test(key)) return failed();
	const found = await lookupToken('api_key', sha256(key));
	if (!found) return failed();
	const [row] = await withTenant(systemCtx(found.tenantId), (tx) =>
		tx
			.select({ grants: apiKeys.grants, membershipId: apiKeys.createdByMembershipId })
			.from(apiKeys)
			.where(eq(apiKeys.id, found.id))
	);
	const holder = row ? await activeHolder(found, row.membershipId) : null;
	if (!holder || !row) return failed();
	const limited = await hitOrLocal('api-key', found.id, API_PER_KEY_MIN, 60_000);
	if (!limited.ok)
		return problem(429, 'rate_limited', 'Too many requests for this key.', {
			'retry-after': String(limited.retryAfter)
		});

	const match = ENDPOINTS.map((e) => ({ e, m: e.path.exec(path) })).find((x) => x.m);
	if (!match) return problem(404, 'not_found', 'No such endpoint.');

	const ctx: TenantCtx = {
		tenantId: holder.tenantId,
		userId: holder.userId,
		employeeId: holder.employeeId,
		actor: 'user'
	};
	try {
		await touch(ctx, found.id);
		return await withTenant(ctx, async (tx) => {
			const creator = await readAccess(tx, {
				id: holder.membershipId,
				status: 'active',
				employeeId: holder.employeeId
			});
			const access: Access = {
				membershipId: holder.membershipId,
				employeeId: holder.employeeId,
				grants: effectiveGrants(row.grants, creator.grants),
				roleKeys: [],
				isOwner: false
			};
			if (!access.grants[match.e.perm]?.length)
				return problem(403, 'forbidden', `This key cannot use ${match.e.perm}.`);
			if (match.e.module && !(await modulesOn(tx)).has(match.e.module))
				return problem(404, 'not_found', 'No such endpoint.');
			return reply(
				200,
				await match.e.run({
					tx,
					access,
					id: match.m![1] ?? '',
					params: Object.fromEntries(new URL(request.url).searchParams)
				})
			);
		});
	} catch (err) {
		if (err instanceof z.ZodError) return problem(400, 'invalid', err.issues[0].message);
		if (err instanceof AppError) return problem(err.status, err.code, err.message);
		log.error({ err, tenantId: holder.tenantId, key: found.id }, 'api request failed');
		return problem(500, 'server_error', 'Something went wrong.');
	}
}
