import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditEvent } from './audit';
import { keyedMac, randomToken, sha256 } from './auth/crypto';
import { now } from './clock';
import { config } from './config';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { employees, kioskDevices, memberSecrets, workSites } from './db/schema';
import { AppError } from './errors';
import { modulesOn } from './modules';
import { clearMemberSecret } from './payslip-mail';
import { userCtx, type requireMember } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { withTenant, type TenantCtx, type Tx } from './tenancy';
import { cidrOk, networks } from './work-sites';

type Member = ReturnType<typeof requireMember>;

export const KIOSK_COOKIE = 'hrms_kiosk';
export const KIOSK_COOKIE_DAYS = 400;
export const KIOSK_PER_DEVICE_MIN = 60;
export const KIOSK_FAILS_BEFORE_LOCK = 5;
export const KIOSK_DEVICE_FAILS_HOUR = 30;
export const KIOSK_MIN_REPLY_MS = 400;
export const KIOSK_PAIR_FAILS_PER_IP_HOUR = 20;
const PAIR_MINUTES = 15;
export const KIOSK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const PIN_PURPOSE = 'kiosk-pin';

export const pinPayload = (tenantId: string, membershipId: string, pin: string) =>
	`${tenantId}\n${membershipId}\n${pin}`;

export function weakPin(pin: string, dateOfBirth: string | null, code: string): boolean {
	const d = [...pin].map(Number);
	const steps = d.slice(1).map((x, i) => (x - d[i] + 10) % 10);
	if (steps.every((s) => s === steps[0]) && [0, 1, 9].includes(steps[0])) return true;
	for (let n = 1; n <= pin.length / 2; n++)
		if (pin.length % n === 0 && pin === pin.slice(0, n).repeat(pin.length / n)) return true;
	if (code.replace(/\D/g, '') === pin) return true;
	if (!dateOfBirth) return false;
	const [y, m, day] = dateOfBirth.split('-');
	const yy = y.slice(2);
	return [day + m + yy, m + day + yy, yy + m + day, day + m + y, m + day + y, y + m + day].includes(pin);
}

const pinSchema = z
	.object({
		pin: z.string().regex(/^\d{6,8}$/, 'Use 6 to 8 digits.'),
		confirm: z.string()
	})
	.refine((v) => v.pin === v.confirm, { message: 'The two PINs do not match.' });

export async function kioskPinSet(tx: Tx, membershipId: string): Promise<boolean> {
	const [row] = await tx
		.select({ mac: memberSecrets.kioskPinMac })
		.from(memberSecrets)
		.where(eq(memberSecrets.membershipId, membershipId));
	return !!row?.mac;
}

async function requireKioskPunch(tx: Tx, m: Member) {
	if (!(await modulesOn(tx)).has('kiosk')) throw new AppError('not_found', 'Not found', 404);
	const employeeId = m.access.employeeId;
	if (!employeeId || !inScope(await resolveScope(tx, m.access, 'attendance.punch'), employeeId))
		throw new AppError('forbidden', 'You cannot punch at a kiosk.', 403);
	return employeeId;
}

export async function setKioskPin(m: Member, raw: Record<string, string>) {
	const { pin } = pinSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const employeeId = await requireKioskPunch(tx, m);
		const [e] = await tx
			.select({ code: employees.code, dateOfBirth: employees.dateOfBirth })
			.from(employees)
			.where(eq(employees.id, employeeId));
		if (!e || weakPin(pin, e.dateOfBirth, e.code))
			throw new AppError('weak_pin', 'Pick a PIN that is not a run, a repeat, your code or your birth date.', 400);
		const mac = keyedMac(PIN_PURPOSE, pinPayload(m.tenant.id, m.access.membershipId, pin));
		await tx
			.insert(memberSecrets)
			.values({ tenantId: m.tenant.id, membershipId: m.access.membershipId, kioskPinMac: mac })
			.onConflictDoUpdate({ target: [memberSecrets.tenantId, memberSecrets.membershipId], set: { kioskPinMac: mac } });
		await auditEvent(tx, userCtx(m), 'member_secrets', m.access.membershipId, 'kiosk_pin.set');
	});
}

export async function resetKioskPin(m: Member, rawCode: string) {
	const code = z.string().trim().min(1).max(40).safeParse(rawCode);
	const ctx = userCtx(m, { kioskPins: true });
	return withTenant(ctx, async (tx) => {
		const [who] = code.success
			? await tx.execute<{ membership_id: string; employee_id: string; name: string }>(sql`
					select tu.membership_id, e.id as employee_id, e.full_name as name from employees e
					join tenant_users tu on tu.employee_id = e.id and tu.membership_status = 'active'
					where lower(e.code) = lower(${code.data}) limit 1`)
			: [];
		if (!who || !inScope(await resolveScope(tx, m.access, 'attendance.manage'), who.employee_id))
			throw new AppError('not_found', 'No one with a sign-in has that employee code.', 404);
		await clearMemberSecret(tx, who.membership_id, 'kioskPinMac');
		await auditEvent(tx, ctx, 'member_secrets', who.membership_id, 'kiosk_pin.reset');
		return who.name;
	});
}

export async function removeKioskPin(m: Member) {
	await withTenant(userCtx(m), async (tx) => {
		await clearMemberSecret(tx, m.access.membershipId, 'kioskPinMac');
		await auditEvent(tx, userCtx(m), 'member_secrets', m.access.membershipId, 'kiosk_pin.remove');
	});
}

const kioskSchema = z.object({
	name: z.string().trim().min(1, 'Enter a name.').max(60, 'Keep the name under 60 characters.'),
	siteId: z.uuid('Pick a work site from the list.'),
	ipCidrs: z
		.string()
		.max(2000, 'Keep the network list shorter.')
		.transform((v) => [...new Set(v.split(/[\s,]+/).filter(Boolean))])
		.refine((list) => list.length <= 20, 'Add at most 20 networks.')
		.refine((list) => list.every(cidrOk), 'Enter networks like 203.0.113.0/24 or 2001:db8::/48.')
});

export const listKiosks = (tx: Tx) =>
	tx
		.select({
			id: kioskDevices.id,
			name: kioskDevices.name,
			siteId: kioskDevices.siteId,
			siteName: workSites.name,
			ipCidrs: sql<string[]>`${kioskDevices.ipCidrs}::text[]`,
			paired: sql<boolean>`${kioskDevices.tokenHash} is not null`,
			pairing: sql<boolean>`${kioskDevices.pairExpiresAt} > now()`,
			lastSeenAt: kioskDevices.lastSeenAt,
			revoked: sql<boolean>`${kioskDevices.revokedAt} is not null`
		})
		.from(kioskDevices)
		.innerJoin(workSites, eq(workSites.id, kioskDevices.siteId))
		.orderBy(asc(kioskDevices.name));

export const kioskSites = (tx: Tx) =>
	tx
		.select({ id: workSites.id, name: workSites.name })
		.from(workSites)
		.where(eq(workSites.active, true))
		.orderBy(asc(workSites.name));

async function liveDevice(tx: Tx, deviceId: string) {
	const id = z.uuid().safeParse(deviceId);
	const [d] = id.success
		? await tx.select({ id: kioskDevices.id }).from(kioskDevices).where(eq(kioskDevices.id, id.data)).for('update')
		: [];
	if (!d) throw new AppError('not_found', 'That kiosk does not exist.', 404);
	return d.id;
}

export async function saveKiosk(ctx: TenantCtx, deviceId: string, raw: Record<string, string>) {
	const input = kioskSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const [site] = await tx
			.select({ id: workSites.id })
			.from(workSites)
			.where(and(eq(workSites.id, input.siteId), eq(workSites.active, true)));
		if (!site) throw new AppError('invalid', 'Pick a work site from the list.', 400);
		const values = { name: input.name, siteId: site.id, ipCidrs: networks(input.ipCidrs) };
		const save = deviceId
			? tx
					.update(kioskDevices)
					.set(values)
					.where(eq(kioskDevices.id, await liveDevice(tx, deviceId)))
			: tx.insert(kioskDevices).values({ tenantId: ctx.tenantId, ...values });
		await save.catch((err) => {
			if (pgCode(err) === UNIQUE_VIOLATION)
				throw new AppError('duplicate', 'A kiosk with that name already exists.', 409);
			throw err;
		});
	});
}

export async function kioskPairLink(ctx: TenantCtx, deviceId: string): Promise<string> {
	const token = randomToken();
	await withTenant(ctx, async (tx) => {
		const id = await liveDevice(tx, deviceId);
		await tx
			.update(kioskDevices)
			.set({
				pairHash: sha256(token),
				pairExpiresAt: sql`now() + make_interval(mins => ${PAIR_MINUTES})`,
				tokenHash: null,
				revokedAt: null
			})
			.where(eq(kioskDevices.id, id));
		await auditEvent(tx, ctx, 'kiosk_devices', id, 'kiosk.pair_link');
	});
	return `${config().APP_URL}/kiosk/pair#${token}`;
}

export async function revokeKiosk(ctx: TenantCtx, deviceId: string) {
	await withTenant(ctx, async (tx) => {
		const id = await liveDevice(tx, deviceId);
		await tx
			.update(kioskDevices)
			.set({ revokedAt: now(), tokenHash: null, pairHash: null, pairExpiresAt: null })
			.where(eq(kioskDevices.id, id));
		await auditEvent(tx, ctx, 'kiosk_devices', id, 'kiosk.revoke');
	});
}
