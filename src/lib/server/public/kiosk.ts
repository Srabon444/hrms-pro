import { fail, type Cookies } from '@sveltejs/kit';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { calendar, checkedPunch } from '../attendance';
import { auditEvent } from '../audit';
import { keyedMac, keyedMacMatches, randomToken, sha256 } from '../auth/crypto';
import { now } from '../clock';
import { zoneFormat } from '../dates';
import { employees, kioskDevices, workSites } from '../db/schema';
import { AppError } from '../errors';
import { actionError } from '../http/forms';
import {
	KIOSK_COOKIE,
	KIOSK_COOKIE_DAYS,
	KIOSK_DEVICE_FAILS_HOUR,
	KIOSK_FAILS_BEFORE_LOCK,
	KIOSK_MIN_REPLY_MS,
	KIOSK_PAIR_FAILS_PER_IP_HOUR,
	KIOSK_PER_DEVICE_MIN,
	KIOSK_TOKEN,
	PIN_PURPOSE,
	pinPayload
} from '../kiosk';
import { log } from '../log';
import { modulesOn } from '../modules';
import { notify, sendAll } from '../notifications';
import { hit, hitOrLocal, overLimit } from '../ratelimit';
import { readAccess } from '../rbac/access';
import { inScope, resolveScope } from '../rbac/scope';
import { redisReady, rkey } from '../redis';
import { systemCtx, withTenant } from '../tenancy';
import { clientIp } from '../work-sites';
import { activeTenant, lookupToken } from './tokens';

const LOCK_MS = 15 * 60_000;
const MAX_LOCK_MS = 24 * 3_600_000;
const HOUR = 3_600_000;
const NO_MATCH = 'That employee code and PIN do not match.';
const DECOY = () => keyedMac(PIN_PURPOSE, pinPayload('decoy', 'decoy', '000000'));

const unavailable = () =>
	new AppError('kiosk_unavailable', 'The kiosk cannot check PINs right now. Punch from your phone or tell HR.', 503);
const closed = <T>(p: Promise<T>) =>
	p.catch((err) => {
		log.warn({ err: (err as Error).message }, 'kiosk limits unavailable; refusing');
		throw unavailable();
	});

export async function pairKiosk(rawCode: string, ip: string): Promise<string> {
	if (await overLimit('kiosk-pair-fail', ip, KIOSK_PAIR_FAILS_PER_IP_HOUR))
		throw new AppError('rate_limited', 'Too many tries. Wait an hour and ask HR for a new link.', 429);
	const refuse = async () => {
		await hitOrLocal('kiosk-pair-fail', ip, KIOSK_PAIR_FAILS_PER_IP_HOUR, HOUR);
		return new AppError('bad_link', 'This pairing link is not valid. Ask HR for a new one.', 400);
	};
	const code = rawCode.trim();
	if (!KIOSK_TOKEN.test(code)) throw await refuse();
	const hash = sha256(code);
	const found = await lookupToken('kiosk_pair', hash);
	const tenant = found && (await activeTenant(found.tenantId));
	if (!found || !tenant) throw await refuse();
	const token = randomToken();
	const paired = await withTenant(systemCtx(found.tenantId), async (tx) => {
		if (!(await modulesOn(tx)).has('kiosk')) return false;
		const rows = await tx
			.update(kioskDevices)
			.set({ tokenHash: sha256(token), pairHash: null, pairExpiresAt: null, lastSeenAt: now() })
			.where(
				and(
					eq(kioskDevices.id, found.id),
					eq(kioskDevices.pairHash, hash),
					sql`${kioskDevices.pairExpiresAt} > now()`,
					isNull(kioskDevices.revokedAt)
				)
			)
			.returning({ id: kioskDevices.id });
		if (rows.length) await auditEvent(tx, systemCtx(found.tenantId), 'kiosk_devices', found.id, 'kiosk.paired');
		return rows.length > 0;
	});
	if (!paired) throw await refuse();
	return token;
}

export type Kiosk = {
	id: string;
	tenantId: string;
	tenantName: string;
	slug: string;
	name: string;
	siteId: string;
	siteName: string;
	onNetwork: boolean;
};

export async function kioskDevice(token: string | undefined, ip: string | null): Promise<Kiosk | null> {
	if (!token || !KIOSK_TOKEN.test(token)) return null;
	const found = await lookupToken('kiosk_device', sha256(token));
	const tenant = found && (await activeTenant(found.tenantId));
	if (!found || !tenant) return null;
	const address = clientIp(ip);
	return withTenant(systemCtx(found.tenantId), async (tx) => {
		if (!(await modulesOn(tx)).has('kiosk')) return null;
		const [d] = await tx
			.select({
				id: kioskDevices.id,
				name: kioskDevices.name,
				siteId: kioskDevices.siteId,
				siteName: workSites.name,
				onNetwork: address
					? sql<boolean>`cardinality(${kioskDevices.ipCidrs}) = 0 or ${address}::inet <<= any(${kioskDevices.ipCidrs})`
					: sql<boolean>`cardinality(${kioskDevices.ipCidrs}) = 0`
			})
			.from(kioskDevices)
			.innerJoin(workSites, eq(workSites.id, kioskDevices.siteId))
			.where(and(eq(kioskDevices.id, found.id), isNull(kioskDevices.revokedAt), eq(workSites.active, true)));
		return d ? { ...d, tenantId: found.tenantId, tenantName: tenant.name, slug: tenant.slug } : null;
	});
}

const punchSchema = z.object({
	code: z.string().trim().min(1, NO_MATCH).max(40, NO_MATCH),
	pin: z.string().regex(/^\d{6,8}$/, NO_MATCH),
	kind: z.enum(['', 'break_start', 'break_end']).catch('')
});

const lockKeys = (deviceId: string, who: string) => {
	const id = `${deviceId}:${who}`;
	return { lock: rkey('kiosk-lock', id), fails: rkey('kiosk-fails', id), level: rkey('kiosk-level', id) };
};
type LockKeys = ReturnType<typeof lockKeys>;

const CHARGE = `local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then return {ttl, 0} end
local n = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[1])
return {0, n}`;

async function chargeAttempt(keys: LockKeys): Promise<{ lockedMs: number; attempt: number }> {
	const r = await redisReady();
	const [ttl, attempt] = (await r.eval(CHARGE, 2, keys.lock, keys.fails, LOCK_MS)) as [number, number];
	return { lockedMs: ttl > 0 ? ttl : attempt > KIOSK_FAILS_BEFORE_LOCK ? LOCK_MS : 0, attempt };
}

async function lockAfterFailure(keys: LockKeys): Promise<number> {
	const r = await redisReady();
	const level = await r.incr(keys.level);
	await r
		.multi()
		.pexpire(keys.level, MAX_LOCK_MS)
		.set(keys.lock, '1', 'PX', Math.min(LOCK_MS * 2 ** (level - 1), MAX_LOCK_MS))
		.del(keys.fails)
		.exec();
	return level;
}

const lockedMessage = (ms: number) =>
	new AppError(
		'kiosk_locked',
		`Too many wrong PINs. Try again in ${Math.ceil(ms / 60_000)} minutes or punch from your phone.`,
		429
	);

const pad = async (start: number) => {
	const wait = KIOSK_MIN_REPLY_MS - (performance.now() - start);
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
};

type Holder = {
	membership_id: string;
	user_id: string;
	membership_status: string;
	employee_id: string;
	code: string;
	pin: string | null;
};

async function tellHr(k: Kiosk, title: string, body: string) {
	const mails = await withTenant(systemCtx(k.tenantId), async (tx) => {
		const hr = await tx.execute<{ id: string }>(sql`
			select distinct tu.membership_id as id from tenant_users tu
			join membership_roles mr on mr.membership_id = tu.membership_id
			join role_permissions rp on rp.role_id = mr.role_id
			where rp.permission = 'attendance.manage' and tu.membership_status = 'active'`);
		return notify(
			tx,
			k.tenantId,
			hr.map((h) => h.id),
			{ category: 'kiosk', title, body, link: 'settings/kiosks' },
			k.slug
		);
	});
	await sendAll(mails);
}

async function afterFailure(k: Kiosk, keys: LockKeys, attempt: number, h: Holder | undefined) {
	const device = await hit('kiosk-device-fail', k.id, KIOSK_DEVICE_FAILS_HOUR, HOUR);
	const level = attempt === KIOSK_FAILS_BEFORE_LOCK ? await lockAfterFailure(keys) : 0;
	const notices = [
		level === 2 && h
			? tellHr(
					k,
					`Kiosk ${k.name} locked code ${h.code} twice`,
					`Someone entered wrong PINs for employee code ${h.code} at ${k.name} again. The code is locked for longer each time.`
				)
			: null,
		device.count === KIOSK_DEVICE_FAILS_HOUR
			? tellHr(
					k,
					`Many wrong PINs at kiosk ${k.name}`,
					`${KIOSK_DEVICE_FAILS_HOUR} wrong PINs were entered at ${k.name} within an hour. Check who is using it.`
				)
			: null
	];
	await Promise.all(notices.map((n) => n?.catch((err) => log.error({ err }, 'kiosk notice failed'))));
}

export async function kioskPunch(k: Kiosk, raw: Record<string, string>) {
	const start = performance.now();
	if (!k.onNetwork) throw new AppError('off_network', 'This kiosk is not on its office network.', 403);
	const limit = await closed(hit('kiosk-device', k.id, KIOSK_PER_DEVICE_MIN, 60_000));
	if (!limit.ok) throw new AppError('rate_limited', 'The kiosk is busy. Wait a minute and try again.', 429);
	const parsed = punchSchema.safeParse(raw);
	if (!parsed.success) {
		await pad(start);
		throw new AppError('no_match', NO_MATCH, 401);
	}
	const input = parsed.data;
	type Refused =
		{ refused: 'locked'; ms: number } | { refused: 'no_match'; keys: LockKeys; attempt: number; h?: Holder };
	const outcome = await withTenant({ ...systemCtx(k.tenantId), kioskPins: true }, async (tx) => {
		const [h] = await tx.execute<Holder>(sql`
			select tu.membership_id, tu.user_id, tu.membership_status, e.id as employee_id, e.code, s.kiosk_pin_mac as pin
			from employees e
			join tenant_users tu on tu.employee_id = e.id and tu.membership_status = 'active' and tu.user_status = 'active'
			left join member_secrets s on s.membership_id = tu.membership_id
			where lower(e.code) = lower(${input.code}) and e.status <> 'exited'
			limit 1`);
		const keys = lockKeys(k.id, h ? `e:${h.employee_id}` : `c:${input.code.toLowerCase()}`);
		const { lockedMs, attempt } = await closed(chargeAttempt(keys));
		if (lockedMs) return { refused: 'locked', ms: lockedMs } satisfies Refused;
		const ok = keyedMacMatches(
			PIN_PURPOSE,
			h?.pin ?? DECOY(),
			pinPayload(k.tenantId, h?.membership_id ?? 'decoy', input.pin)
		);
		if (!h?.pin || !ok) return { refused: 'no_match', keys, attempt, h } satisfies Refused;
		await closed(redisReady().then((r) => r.del(keys.fails, keys.level)));
		const access = await readAccess(tx, {
			id: h.membership_id,
			status: h.membership_status,
			employeeId: h.employee_id
		});
		const [e] = await tx.select().from(employees).where(eq(employees.id, h.employee_id)).for('update');
		if (!e || !inScope(await resolveScope(tx, access, 'attendance.punch'), e.id))
			throw new AppError('forbidden', 'You cannot punch at this kiosk. Ask HR.', 403);
		const done = await checkedPunch(
			tx,
			{ tenantId: k.tenantId, userId: h.user_id },
			e,
			'kiosk',
			input.kind || null,
			async () => ({
				ip: null,
				point: null,
				siteId: k.siteId,
				outsideSite: false
			})
		);
		await tx.update(kioskDevices).set({ lastSeenAt: done.at }).where(eq(kioskDevices.id, k.id));
		const { timeZone } = await calendar(tx, e.id);
		return {
			firstName: e.fullName.trim().split(/\s+/)[0],
			time: zoneFormat(timeZone, { timeStyle: 'short', hourCycle: 'h23' }, 'sv-SE').format(done.at),
			kind: input.kind
		};
	});
	if ('refused' in outcome) {
		if (outcome.refused === 'no_match') await closed(afterFailure(k, outcome.keys, outcome.attempt, outcome.h));
		await pad(start);
		throw outcome.refused === 'locked' ? lockedMessage(outcome.ms) : new AppError('no_match', NO_MATCH, 401);
	}
	return outcome;
}

export type KioskScreen = { name: string; tenantName: string; siteName: string; onNetwork: boolean };

export async function kioskScreen(cookies: Cookies, ip: string): Promise<KioskScreen | null> {
	const k = await kioskDevice(cookies.get(KIOSK_COOKIE), ip);
	return k ? { name: k.name, tenantName: k.tenantName, siteName: k.siteName, onNetwork: k.onNetwork } : null;
}

export async function kioskPunchAction(cookies: Cookies, ip: string, form: FormData, requestId: string) {
	const k = await kioskDevice(cookies.get(KIOSK_COOKIE), ip);
	if (!k) return fail(401, { message: 'This browser is not set up as a kiosk. Ask HR for a pairing link.' });
	const raw = Object.fromEntries(['code', 'pin', 'kind'].map((f) => [f, String(form.get(f) ?? '')]));
	try {
		return { punched: await kioskPunch(k, raw) };
	} catch (err) {
		return actionError(err, requestId);
	}
}

export async function pairKioskAction(cookies: Cookies, url: URL, ip: string, form: FormData, requestId: string) {
	try {
		const token = await pairKiosk(String(form.get('code') ?? ''), ip);
		cookies.set(KIOSK_COOKIE, token, {
			path: '/kiosk',
			httpOnly: true,
			sameSite: 'strict',
			secure: url.protocol === 'https:',
			maxAge: KIOSK_COOKIE_DAYS * 24 * 3600
		});
		return { paired: true };
	} catch (err) {
		return actionError(err, requestId);
	}
}
