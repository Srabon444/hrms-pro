import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { covers } from '../rbac/grants';
import { API_REAUTH_MINUTES } from './api-keys';
import { employeeZone, recomputeAttendance } from './attendance';
import { shiftDayOf } from './attendance-day';
import { auditEvent } from './audit';
import { randomToken, sha256 } from './auth/crypto';
import { requireRecentAuth } from './auth/session';
import { now } from './clock';
import { addDays, dateIn } from './dates';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { attendanceDevices, attendancePunches, employees, workSites } from './db/schema';
import { AppError } from './errors';
import { payrollClosedMonths } from './payroll';
import { userCtx, type requireMember } from './rbac/access';
import { dayRules } from './rest-days';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const DEVICE_KEY = /^hrd_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
export const DEVICE_BATCH_MAX = 500;
export const DEVICE_MAX_AGE_DAYS = 31;
export const DEVICE_MAX_AHEAD_MS = 5 * 60_000;
const DAY = 86_400_000;
const REVIEW_LIST_MAX = 200;

export const manager = (m: Member) => {
	if (!covers(m.access.grants['attendance.manage'], 'all'))
		throw new AppError('forbidden', 'Only people who manage everyone’s attendance can manage devices.', 403);
};

const newKey = () => {
	const prefix = randomBytes(4).toString('hex');
	const key = `hrd_${prefix}_${randomToken()}`;
	return { key, prefix, keyHash: sha256(key) };
};

const deviceSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, 'Enter a name.')
		.max(60, 'Keep the name under 60 characters.')
		.regex(/^[^\p{Cc}]+$/u, 'Use letters, numbers and spaces in the name.'),
	siteId: z
		.string()
		.transform((v) => v || null)
		.pipe(z.uuid('Pick a work site from the list.').nullable()),
	serial: z
		.string()
		.trim()
		.max(64, 'Keep the serial number under 64 characters.')
		.regex(/^[^\p{Cc}]*$/u, 'Use letters and numbers in the serial number.')
		.transform((v) => v || null)
});

const missing = () => new AppError('not_found', 'That device does not exist or is switched off.', 404);
const idOf = (raw: string) => {
	const id = z.uuid().safeParse(raw);
	if (!id.success) throw missing();
	return id.data;
};

export async function createDevice(m: Member, raw: Record<string, string>): Promise<string> {
	manager(m);
	await requireRecentAuth(m.user.sessionId, API_REAUTH_MINUTES);
	const input = deviceSchema.parse({ name: raw.name ?? '', siteId: raw.siteId ?? '', serial: raw.serial ?? '' });
	const { key, prefix, keyHash } = newKey();
	await withTenant(userCtx(m), async (tx) => {
		if (input.siteId) {
			const [site] = await tx.select({ id: workSites.id }).from(workSites).where(eq(workSites.id, input.siteId));
			if (!site) throw new AppError('invalid', 'Pick a work site from the list.', 400);
		}
		const [row] = await tx
			.insert(attendanceDevices)
			.values({ tenantId: m.tenant.id, ...input, prefix, keyHash })
			.returning({ id: attendanceDevices.id })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('duplicate', 'A device with that name already exists. Pick another name.', 409);
				throw err;
			});
		await auditEvent(tx, userCtx(m), 'attendance_devices', row.id, 'attendance_device.create', { name: input.name });
	});
	return key;
}

export async function rotateDeviceKey(m: Member, rawId: string): Promise<string> {
	manager(m);
	await requireRecentAuth(m.user.sessionId, API_REAUTH_MINUTES);
	const id = idOf(rawId);
	const { key, prefix, keyHash } = newKey();
	await withTenant(userCtx(m), async (tx) => {
		const [row] = await tx
			.update(attendanceDevices)
			.set({ prefix, keyHash })
			.where(and(eq(attendanceDevices.id, id), isNull(attendanceDevices.revokedAt)))
			.returning({ id: attendanceDevices.id });
		if (!row) throw missing();
		await auditEvent(tx, userCtx(m), 'attendance_devices', id, 'attendance_device.rotate');
	});
	return key;
}

export async function revokeDevice(m: Member, rawId: string): Promise<void> {
	manager(m);
	const id = idOf(rawId);
	await withTenant(userCtx(m), async (tx) => {
		const [row] = await tx
			.update(attendanceDevices)
			.set({ revokedAt: now() })
			.where(and(eq(attendanceDevices.id, id), isNull(attendanceDevices.revokedAt)))
			.returning({ id: attendanceDevices.id });
		if (!row) throw missing();
	});
}

export const listDevices = (tx: Tx) =>
	tx
		.select({
			id: attendanceDevices.id,
			name: attendanceDevices.name,
			siteName: workSites.name,
			serial: attendanceDevices.serial,
			prefix: attendanceDevices.prefix,
			lastSeenAt: attendanceDevices.lastSeenAt,
			revoked: sql<boolean>`${attendanceDevices.revokedAt} is not null`
		})
		.from(attendanceDevices)
		.leftJoin(workSites, eq(workSites.id, attendanceDevices.siteId))
		.orderBy(asc(attendanceDevices.name));

export const listDeviceUsers = (tx: Tx) =>
	tx
		.select({ code: employees.code, fullName: employees.fullName, deviceUserId: employees.deviceUserId })
		.from(employees)
		.where(sql`${employees.deviceUserId} is not null`)
		.orderBy(asc(employees.code));

const deviceUserSchema = z.object({
	code: z.string().trim().min(1, 'Enter the employee code.').max(40, 'That employee code is too long.'),
	deviceUserId: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_.-]{0,32}$/, 'Use up to 32 letters, numbers, dots, dashes or underscores.')
		.transform((v) => v || null)
});

export async function setDeviceUserId(m: Member, raw: Record<string, string>): Promise<string> {
	manager(m);
	const input = deviceUserSchema.parse({ code: raw.code ?? '', deviceUserId: raw.deviceUserId ?? '' });
	return withTenant(userCtx(m), async (tx) => {
		const [row] = await tx
			.update(employees)
			.set({ deviceUserId: input.deviceUserId })
			.where(sql`lower(${employees.code}) = lower(${input.code})`)
			.returning({ fullName: employees.fullName })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('duplicate', 'Another employee already has that device user ID.', 409);
				throw err;
			});
		if (!row) throw new AppError('not_found', 'No employee has that code.', 404);
		return row.fullName;
	});
}

export const listReview = (tx: Tx) =>
	tx
		.select({
			id: attendancePunches.id,
			at: attendancePunches.at,
			source: attendancePunches.source,
			code: employees.code,
			fullName: employees.fullName,
			device: attendanceDevices.name
		})
		.from(attendancePunches)
		.innerJoin(employees, eq(employees.id, attendancePunches.employeeId))
		.leftJoin(attendanceDevices, eq(attendanceDevices.id, attendancePunches.deviceId))
		.where(eq(attendancePunches.needsReview, true))
		.orderBy(asc(attendancePunches.at))
		.limit(REVIEW_LIST_MAX);

export async function clearReview(m: Member, rawIds: string[]): Promise<number> {
	manager(m);
	const ids = z.array(z.uuid()).max(REVIEW_LIST_MAX).safeParse(rawIds);
	if (!ids.success || !ids.data.length) throw new AppError('invalid', 'Pick the punches you have checked.', 400);
	return withTenant(userCtx(m), async (tx) => {
		const done = await tx
			.update(attendancePunches)
			.set({ needsReview: false })
			.where(and(inArray(attendancePunches.id, ids.data), eq(attendancePunches.needsReview, true)))
			.returning({ id: attendancePunches.id });
		if (done.length)
			await auditEvent(tx, userCtx(m), 'attendance_punches', null, 'attendance_punch.reviewed', {
				count: String(done.length)
			});
		return done.length;
	});
}

const itemSchema = z
	.object({
		deviceUserId: z.string().trim().min(1).max(32).optional(),
		employeeCode: z.string().trim().min(1).max(40).optional(),
		at: z.iso.datetime({
			offset: true,
			message: 'at must be an RFC 3339 time with an offset, like 2026-11-27T09:00:00+06:00.'
		}),
		direction: z.enum(['in', 'out'], 'direction must be in or out.').optional()
	})
	.refine((v) => v.deviceUserId !== undefined || v.employeeCode !== undefined, 'Send deviceUserId or employeeCode.');

const batchSchema = z.object(
	{
		punches: z
			.array(z.unknown(), 'Send punches as a list.')
			.min(1, 'Send at least one punch.')
			.max(DEVICE_BATCH_MAX, `Send at most ${DEVICE_BATCH_MAX} punches at a time.`)
	},
	'Send a JSON object with a punches list.'
);

export type Rejected = { index: number; reason: string; message: string };
export type PunchResult =
	| { index: number; status: 'accepted'; flagged: boolean }
	| { index: number; status: 'duplicate' }
	| (Rejected & { status: 'rejected' });

export function readBatch(raw: unknown) {
	const { punches } = batchSchema.parse(raw);
	const rejected: Rejected[] = [];
	const ok = punches.flatMap((p, index) => {
		const r = itemSchema.safeParse(p);
		if (r.success) return [{ index, ...r.data, at: new Date(r.data.at) }];
		rejected.push({ index, reason: 'invalid', message: r.error.issues[0].message });
		return [];
	});
	return { ok, rejected };
}

export async function ingestPunches(tenantId: string, deviceId: string, raw: unknown) {
	const { ok, rejected } = readBatch(raw);
	return withTenant(systemCtx(tenantId), async (tx) => {
		const [device] = await tx
			.select({ siteId: attendanceDevices.siteId, lastSeenAt: attendanceDevices.lastSeenAt })
			.from(attendanceDevices)
			.where(and(eq(attendanceDevices.id, deviceId), isNull(attendanceDevices.revokedAt)));
		if (!device) throw new AppError('unauthorized', 'This device key was switched off.', 401);
		const userIds = [...new Set(ok.flatMap((p) => (p.deviceUserId ? [p.deviceUserId] : [])))];
		const codes = [...new Set(ok.flatMap((p) => (p.deviceUserId ? [] : [p.employeeCode!.toLowerCase()])))];
		const people =
			userIds.length || codes.length
				? await tx
						.select({
							id: employees.id,
							code: employees.code,
							deviceUserId: employees.deviceUserId,
							joinDate: employees.joinDate,
							exitDate: employees.exitDate,
							zone: employeeZone
						})
						.from(employees)
						.where(
							or(
								userIds.length ? inArray(employees.deviceUserId, userIds) : undefined,
								codes.length ? inArray(sql`lower(${employees.code})`, codes) : undefined
							)
						)
				: [];
		const byUser = new Map(people.flatMap((e) => (e.deviceUserId ? [[e.deviceUserId, e] as const] : [])));
		const byCode = new Map(people.map((e) => [e.code.toLowerCase(), e]));
		const t = now().getTime();
		const timely = ok.flatMap((p) => {
			const e = p.deviceUserId ? byUser.get(p.deviceUserId) : byCode.get(p.employeeCode!.toLowerCase());
			const why = !e
				? (['unknown_user', 'No employee has that device user ID or code.'] as const)
				: p.at.getTime() < t - DEVICE_MAX_AGE_DAYS * DAY
					? (['too_old', `Punches older than ${DEVICE_MAX_AGE_DAYS} days are not accepted.`] as const)
					: p.at.getTime() > t + DEVICE_MAX_AHEAD_MS
						? (['in_future', 'That punch is in the future. Check the device clock.'] as const)
						: null;
			if (why || !e) {
				rejected.push({ index: p.index, reason: why![0], message: why![1] });
				return [];
			}
			return [{ ...p, e, local: dateIn(p.at, e.zone) }];
		});
		const locals = timely.map((p) => p.local).sort();
		const rules = timely.length
			? await dayRules(tx, [...new Set(timely.map((p) => p.e.id))], locals[0], locals.at(-1)!)
			: null;
		const rows = timely.flatMap((p) => {
			const shift = rules!(p.e.id, p.local).shift;
			const day = shift ? shiftDayOf(p.at, shift, p.e.zone) : p.local;
			if (day < p.e.joinDate || (p.e.exitDate && day > addDays(p.e.exitDate, 1))) {
				rejected.push({ index: p.index, reason: 'not_employed', message: 'Punches only count while employed.' });
				return [];
			}
			return [{ index: p.index, employeeId: p.e.id, at: p.at, day, kind: p.direction ?? null }];
		});
		const closed = await payrollClosedMonths(
			tx,
			[...new Set(rows.map((r) => r.employeeId))],
			[...new Set(rows.map((r) => r.day.slice(0, 7)))]
		);
		const flag = (r: (typeof rows)[number]) => closed.has(`${r.employeeId}:${r.day.slice(0, 7)}`);
		const saved = rows.length
			? await tx
					.insert(attendancePunches)
					.values(
						rows.map((r) => ({
							tenantId,
							employeeId: r.employeeId,
							at: r.at,
							source: 'device',
							kind: r.kind,
							siteId: device.siteId,
							deviceId,
							needsReview: flag(r)
						}))
					)
					.onConflictDoNothing()
					.returning({ employeeId: attendancePunches.employeeId, at: attendancePunches.at })
			: [];
		const fresh = new Set(saved.map((s) => `${s.employeeId}:${s.at.getTime()}`));
		const span = new Map<string, { from: string; to: string }>();
		const results: PunchResult[] = [
			...rows.map((r) => {
				if (!fresh.delete(`${r.employeeId}:${r.at.getTime()}`)) return { index: r.index, status: 'duplicate' as const };
				const had = span.get(r.employeeId);
				span.set(r.employeeId, {
					from: had && had.from < r.day ? had.from : r.day,
					to: had && had.to > r.day ? had.to : r.day
				});
				return { index: r.index, status: 'accepted' as const, flagged: flag(r) };
			}),
			...rejected.map((r) => ({ ...r, status: 'rejected' as const }))
		].sort((a, b) => a.index - b.index);
		const groups = new Map<string, string[]>();
		for (const [id, { from, to }] of span) groups.set(`${from}|${to}`, [...(groups.get(`${from}|${to}`) ?? []), id]);
		await Promise.all(
			[...groups].map(([key, ids]) => {
				const [from, to] = key.split('|');
				return recomputeAttendance(tx, tenantId, addDays(from, -1), addDays(to, 1), ids);
			})
		);
		const dayStart = new Date(t - (t % DAY));
		await tx
			.update(attendanceDevices)
			.set({ lastSeenAt: new Date(t) })
			.where(
				and(
					eq(attendanceDevices.id, deviceId),
					or(isNull(attendanceDevices.lastSeenAt), lt(attendanceDevices.lastSeenAt, dayStart))
				)
			);
		const count = (status: PunchResult['status']) => results.filter((r) => r.status === status).length;
		return {
			accepted: count('accepted'),
			duplicates: count('duplicate'),
			rejected: count('rejected'),
			flagged: results.filter((r) => r.status === 'accepted' && r.flagged).length,
			results
		};
	});
}
