import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MODULE_IDS, MODULES } from '../../src/lib/modules';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { attendancePunches, employees, memberships, notifications } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import {
	KIOSK_FAILS_BEFORE_LOCK,
	KIOSK_MIN_REPLY_MS,
	kioskPairLink,
	kioskPinSet,
	listKiosks,
	removeKioskPin,
	resetKioskPin,
	revokeKiosk,
	saveKiosk,
	setKioskPin
} from '../../src/lib/server/kiosk';
import { saveModules } from '../../src/lib/server/modules';
import { pdfPasswordSet, removePdfPassword } from '../../src/lib/server/payslip-mail';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { kioskDevice, kioskPunch, pairKiosk, type Kiosk } from '../../src/lib/server/public/kiosk';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { listWorkSites, savePunchRule, saveWorkSite } from '../../src/lib/server/work-sites';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

const redisDown = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/lib/server/redis', async (orig) => {
	const real = await orig<typeof import('../../src/lib/server/redis')>();
	return {
		...real,
		redisReady: (t?: number) => (redisDown.on ? Promise.reject(new Error('redis down')) : real.redisReady(t))
	};
});

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let tenant: Tenant;
let other: Tenant;
const ids: Record<string, string> = {};
const codes: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = (t = tenant) => systemCtx(t.id);
const secrets = () => ({ ...sys(), kioskPins: true, payrollAll: true });
const ctx = (t = tenant) => ({ tenantId: t.id, actor: 'user' as const });
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'] },
	roleKeys: [],
	isOwner: false
};

async function member(
	t: Tenant,
	key: string,
	roleKeys: string[],
	fullName: string,
	extra: Record<string, string> = {}
) {
	const employeeId = await createEmployee({ tenantId: t.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01',
		...extra
	});
	const u = await createUser();
	const id = await withTenant(sys(t), async (tx) => {
		const membershipId = await addMember(tx, t.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		const [e] = await tx.select({ code: employees.code }).from(employees).where(eq(employees.id, employeeId));
		codes[key] = e.code;
		return membershipId;
	});
	ids[key] = employeeId;
	who[key] = {
		user: { userId: u.id },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: await loadAccess(t.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const defaults = MODULE_IDS.filter((id) => MODULES[id].on);
const kioskModule = (on: boolean, t = tenant) => saveModules(sys(t), on ? [...defaults, 'kiosk'] : defaults);
const NOW = '2026-11-24T09:00:00+06:00';
const at = <T>(iso: string, fn: () => Promise<T>) => withTestNow(iso, fn);
const PIN = { ana: '482915', bea: '730192', cal: '615284', dan: '948261' };
const setPin = (key: keyof typeof PIN) => setKioskPin(who[key], { pin: PIN[key], confirm: PIN[key] });

async function newKiosk(name: string, ipCidrs = '', t = tenant): Promise<{ id: string; token: string }> {
	const [site] = await withTenant(sys(t), listWorkSites);
	await saveKiosk(ctx(t), '', { name, siteId: site.id, ipCidrs });
	const k = (await withTenant(sys(t), listKiosks)).find((x) => x.name === name)!;
	const link = await kioskPairLink(ctx(t), k.id);
	const token = await pairKiosk(link.split('#')[1], '198.51.100.7');
	return { id: k.id, token };
}

const device = async (token: string, ip: string | null = '198.51.100.7') => (await kioskDevice(token, ip)) as Kiosk;
const timed = async (p: () => Promise<unknown>) => {
	const start = performance.now();
	const result = await code(p());
	return { result, ms: performance.now() - start };
};
const punches = (employeeId: string, t = tenant) =>
	withTenant(sys(t), (tx) => tx.select().from(attendancePunches).where(eq(attendancePunches.employeeId, employeeId)));

beforeAll(async () => {
	const r = await redisReady();
	await r.del(...['198.51.100.7', '198.51.100.8', '198.51.100.9'].map((ip) => rkey('rl', 'kiosk-pair-fail', ip)));
	tenant = await createTenant('kiosk');
	other = await createTenant('kioskb');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(sys(other), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	await member(tenant, 'hr', ['hr_admin'], 'Hana Rahman');
	await member(tenant, 'ana', ['employee'], 'Ana Karim', { dateOfBirth: '1990-03-15' });
	await member(tenant, 'bea', ['employee'], 'Bea Das');
	await member(tenant, 'cal', ['employee'], 'Cal Roy');
	await member(tenant, 'dan', ['employee'], 'Dan Ito');
	await member(other, 'olga', ['employee'], 'Olga Sen');
	await saveWorkSite(ctx(), '', {
		name: 'HQ',
		branchId: '',
		lat: '23.7808',
		lng: '90.4074',
		radiusM: '200',
		ipCidrs: '',
		active: 'on'
	});
	await saveWorkSite(ctx(other), '', {
		name: 'Other HQ',
		branchId: '',
		lat: '23.7808',
		lng: '90.4074',
		radiusM: '200',
		ipCidrs: '',
		active: 'on'
	});
});

afterAll(async () => {
	await closeRedis();
	await closePools();
});

describe('kiosk module off', () => {
	it('refuses PINs, kiosk setup and paired devices while the module is off', async () => {
		expect(await code(setPin('ana'))).toBe('not_found');
		await kioskModule(true);
		const k = await newKiosk('Gate off test');
		expect(await kioskDevice(k.token, null)).not.toBeNull();
		await kioskModule(false);
		expect(await kioskDevice(k.token, null)).toBeNull();
		const link = await kioskPairLink(ctx(), k.id);
		expect(await code(pairKiosk(link.split('#')[1], '198.51.100.8'))).toBe('bad_link');
		await kioskModule(true);
	});
});

describe('kiosk PINs', () => {
	it('refuses weak and mismatched PINs and stores only a keyed MAC with an audit row', async () => {
		expect(await code(setKioskPin(who.ana, { pin: '123456', confirm: '123456' }))).toBe('weak_pin');
		expect(await code(setKioskPin(who.ana, { pin: '150390', confirm: '150390' }))).toBe('weak_pin');
		expect(await code(setKioskPin(who.ana, { pin: '12345', confirm: '12345' }))).toBe('invalid');
		expect(await code(setKioskPin(who.ana, { pin: '482915', confirm: '482916' }))).toBe('invalid');
		expect(await code(setPin('ana'))).toBe('ok');
		const [row] = await ownerPool().sql<{ mac: string; enc: string | null }[]>`
			select kiosk_pin_mac as mac, pdf_password_enc as enc from member_secrets
			where membership_id = ${who.ana.access.membershipId}`;
		expect(row.mac).toMatch(/^[^:]+:[A-Za-z0-9_-]{43}$/);
		expect(row.mac).not.toContain(PIN.ana);
		expect(row.enc).toBeNull();
		expect(await withTenant(secrets(), (tx) => pdfPasswordSet(tx, who.ana.access.membershipId))).toBe(false);
		expect(await withTenant(secrets(), (tx) => kioskPinSet(tx, who.ana.access.membershipId))).toBe(true);
		expect(await auditEvents(who.ana.access.membershipId)).toEqual(['kiosk_pin.set']);
		expect(await code(setPin('bea'))).toBe('ok');
		expect(await code(setPin('cal'))).toBe('ok');
	});

	it('keeps the payslip password when the kiosk PIN is removed or reset', async () => {
		await ownerPool()
			.sql`update member_secrets set pdf_password_enc = 'kept' where membership_id = ${who.cal.access.membershipId}`;
		await removeKioskPin(who.cal);
		const [row] = await ownerPool().sql<{ mac: string | null; enc: string | null }[]>`
			select kiosk_pin_mac as mac, pdf_password_enc as enc from member_secrets where membership_id = ${who.cal.access.membershipId}`;
		expect(row).toEqual({ mac: null, enc: 'kept' });
		expect(await code(setPin('cal'))).toBe('ok');
		expect(await resetKioskPin(who.hr, codes.cal.toLowerCase())).toBe('Cal Roy');
		expect(await withTenant(secrets(), (tx) => kioskPinSet(tx, who.cal.access.membershipId))).toBe(false);
		expect(await auditEvents(who.cal.access.membershipId)).toEqual(
			expect.arrayContaining(['kiosk_pin.set', 'kiosk_pin.remove', 'kiosk_pin.reset'])
		);
		await ownerPool().sql`delete from member_secrets where membership_id = ${who.cal.access.membershipId}`;
		expect(await code(resetKioskPin(who.hr, 'NOPE-1'))).toBe('not_found');
		expect(await code(resetKioskPin(who.olga, codes.olga))).toBe('not_found');
		expect(await code(resetKioskPin(who.ana, codes.bea))).toBe('not_found');
		expect(await code(setPin('cal'))).toBe('ok');
	});
});

async function auditEvents(rowId: string) {
	const rows = await ownerPool().sql<{ event: string }[]>`
		select event from audit_log where table_name = 'member_secrets' and row_id = ${rowId}`;
	return rows.map((r) => r.event);
}

describe('kiosk pairing', () => {
	it('pairs once, refuses another tenant site, and stops working after a switch-off', async () => {
		const [otherSite] = await withTenant(sys(other), listWorkSites);
		expect(await code(saveKiosk(ctx(), '', { name: 'Bad site', siteId: otherSite.id, ipCidrs: '' }))).toBe('invalid');
		expect(await code(saveKiosk(ctx(), '', { name: 'Bad net', siteId: otherSite.id, ipCidrs: '10.0.0.01/8' }))).toBe(
			'invalid'
		);
		const [site] = await withTenant(sys(), listWorkSites);
		await saveKiosk(ctx(), '', { name: 'Front desk', siteId: site.id, ipCidrs: '' });
		const k = (await withTenant(sys(), listKiosks)).find((x) => x.name === 'Front desk')!;
		expect(await code(saveKiosk(ctx(), '', { name: 'Front desk', siteId: site.id, ipCidrs: '' }))).toBe('duplicate');
		const link = await kioskPairLink(ctx(), k.id);
		expect(link).toMatch(/\/kiosk\/pair#[A-Za-z0-9_-]{43}$/);
		const pairCode = link.split('#')[1];
		const token = await pairKiosk(pairCode, '198.51.100.9');
		expect(await code(pairKiosk(pairCode, '198.51.100.9'))).toBe('bad_link');
		expect(await code(pairKiosk('x'.repeat(43), '198.51.100.9'))).toBe('bad_link');
		const d = await device(token);
		expect(d).toMatchObject({ tenantId: tenant.id, siteId: site.id, onNetwork: true });
		expect(await code(revokeKiosk(ctx(other), k.id))).toBe('not_found');
		expect(await code(kioskPairLink(ctx(other), k.id))).toBe('not_found');
		const [stored] = await ownerPool().sql<
			{ token_hash: string }[]
		>`select token_hash from kiosk_devices where id = ${k.id}`;
		expect(stored.token_hash).not.toBe(token);
		await revokeKiosk(ctx(), k.id);
		expect(await kioskDevice(token, null)).toBeNull();
		const again = await pairKiosk((await kioskPairLink(ctx(), k.id)).split('#')[1], '198.51.100.9');
		expect(await kioskDevice(again, null)).not.toBeNull();
		expect(await kioskDevice(token, null)).toBeNull();
	});

	it('refuses kiosks bound to an office network when the request comes from elsewhere', async () => {
		const k = await newKiosk('Bound', '10.0.0.0/8');
		expect((await device(k.token, '10.4.5.6')).onNetwork).toBe(true);
		expect((await device(k.token, '::ffff:10.4.5.6')).onNetwork).toBe(true);
		const away = await device(k.token, '192.0.2.1');
		expect(away.onNetwork).toBe(false);
		expect(await code(kioskPunch(away, { code: codes.bea, pin: PIN.bea }))).toBe('off_network');
		expect((await device(k.token, null)).onNetwork).toBe(false);
	});
});

describe('kiosk punches', () => {
	it('records a kiosk punch at the kiosk site even when away punches are blocked', async () => {
		await ownerPool().sql`delete from attendance_punches where employee_id = ${ids.ana}`;
		await savePunchRule(ctx(), 'block');
		const k = await newKiosk('Lobby');
		const d = await device(k.token);
		const done = await at('2026-11-25T09:02:00+06:00', () =>
			kioskPunch(d, { code: codes.ana.toLowerCase(), pin: PIN.ana })
		);
		expect(done).toEqual({ firstName: 'Ana', time: '09:02', kind: '' });
		expect(await code(at('2026-11-25T09:02:30+06:00', () => kioskPunch(d, { code: codes.ana, pin: PIN.ana })))).toBe(
			'too_soon'
		);
		const [p] = (await punches(ids.ana)).filter((x) => x.at.toISOString() === '2026-11-25T03:02:00.000Z');
		expect(p).toMatchObject({
			source: 'kiosk',
			siteId: d.siteId,
			outsideSite: false,
			ip: null,
			createdByUserId: who.ana.user.userId
		});
		expect(
			await code(
				at('2026-11-25T13:00:00+06:00', () => kioskPunch(d, { code: codes.ana, pin: PIN.ana, kind: 'break_end' }))
			)
		).toBe('no_break');
		expect(
			await at('2026-11-25T13:00:00+06:00', () => kioskPunch(d, { code: codes.ana, pin: PIN.ana, kind: 'break_start' }))
		).toMatchObject({ kind: 'break_start' });
		await savePunchRule(ctx(), 'off');
		const [seen] = await ownerPool().sql<
			{ last_seen_at: Date }[]
		>`select last_seen_at from kiosk_devices where id = ${d.id}`;
		expect(new Date(seen.last_seen_at).toISOString()).toBe('2026-11-25T07:00:00.000Z');
	});

	it('gives the same answer in the same time for an unknown code and a wrong PIN', async () => {
		const d = await device((await newKiosk('Timing')).token);
		const unknown = await timed(() => kioskPunch(d, { code: 'NOPE-999', pin: '581937' }));
		const wrong = await timed(() => kioskPunch(d, { code: codes.bea, pin: '581937' }));
		const malformed = await timed(() => kioskPunch(d, { code: codes.bea, pin: '12' }));
		const noPin = await timed(() => kioskPunch(d, { code: codes.hr, pin: '581937' }));
		for (const t of [unknown, wrong, malformed, noPin]) {
			expect(t.result).toBe('no_match');
			expect(t.ms).toBeGreaterThanOrEqual(KIOSK_MIN_REPLY_MS - 5);
		}
		expect(Math.abs(unknown.ms - wrong.ms)).toBeLessThan(120);
		expect(await code(kioskPunch(d, { code: codes.olga, pin: PIN.ana }))).toBe('no_match');
		expect(await punches(ids.olga, other)).toHaveLength(0);
	});

	it('refuses suspended members and exited employees with the same answer', async () => {
		const d = await device((await newKiosk('Leavers')).token);
		await withTenant(sys(), (tx) =>
			tx.update(memberships).set({ status: 'disabled' }).where(eq(memberships.id, who.cal.access.membershipId))
		);
		expect(await code(at(NOW, () => kioskPunch(d, { code: codes.cal, pin: PIN.cal })))).toBe('no_match');
		await withTenant(sys(), (tx) =>
			tx.update(memberships).set({ status: 'active' }).where(eq(memberships.id, who.cal.access.membershipId))
		);
		await withTenant(sys(), (tx) => tx.update(employees).set({ status: 'exited' }).where(eq(employees.id, ids.cal)));
		expect(await code(at(NOW, () => kioskPunch(d, { code: codes.cal, pin: PIN.cal })))).toBe('no_match');
		await withTenant(sys(), (tx) => tx.update(employees).set({ status: 'active' }).where(eq(employees.id, ids.cal)));
		expect(await punches(ids.cal)).toHaveLength(0);
	});

	it('locks a code after repeated wrong PINs, doubles the lock and tells HR the second time', async () => {
		const d = await device((await newKiosk('Brute')).token);
		const lockKey = rkey('kiosk-lock', `${d.id}:e:${ids.bea}`);
		const wrong = () => code(kioskPunch(d, { code: codes.bea, pin: '581937' }));
		const tries = await Array.from({ length: KIOSK_FAILS_BEFORE_LOCK }).reduce<Promise<string[]>>(
			async (acc) => [...(await acc), await wrong()],
			Promise.resolve([])
		);
		expect(tries).toEqual(Array(KIOSK_FAILS_BEFORE_LOCK).fill('no_match'));
		expect(await code(at(NOW, () => kioskPunch(d, { code: codes.bea, pin: PIN.bea })))).toBe('kiosk_locked');
		const r = await redisReady();
		expect(await r.pttl(lockKey)).toBeGreaterThan(14 * 60_000);
		await r.del(lockKey);
		await Array.from({ length: KIOSK_FAILS_BEFORE_LOCK }).reduce<Promise<unknown>>(
			async (acc) => (await acc, wrong()),
			Promise.resolve()
		);
		expect(await r.pttl(lockKey)).toBeGreaterThan(29 * 60_000);
		const told = await withTenant(sys(), (tx) =>
			tx
				.select({ title: notifications.title })
				.from(notifications)
				.where(and(eq(notifications.membershipId, who.hr.access.membershipId), eq(notifications.category, 'kiosk')))
		);
		expect(told).toHaveLength(1);
		expect(told[0].title).toContain(codes.bea);
		const elsewhere = await device((await newKiosk('Brute two')).token);
		expect(
			await code(at('2026-11-26T09:00:00+06:00', () => kioskPunch(elsewhere, { code: codes.bea, pin: PIN.bea })))
		).toBe('ok');
		expect(await punches(ids.bea)).toHaveLength(1);
	});

	it('holds the lock against a parallel burst, other spellings of the code, and junk codes', async () => {
		await withTenant(sys(), (tx) => tx.update(employees).set({ code: 'ID-0009' }).where(eq(employees.id, ids.dan)));
		expect(await code(setPin('dan'))).toBe('ok');
		const d = await device((await newKiosk('Burst')).token);
		const pins = Array.from({ length: 20 }, (_, i) => String(581900 + i));
		const burst = await at('2026-11-26T10:00:00+06:00', () =>
			Promise.all(pins.map((pin) => code(kioskPunch(d, { code: 'ID-0009', pin }))))
		);
		const misses = burst.filter((r) => r === 'no_match').length;
		expect(misses).toBeLessThanOrEqual(KIOSK_FAILS_BEFORE_LOCK);
		expect(burst.filter((r) => r === 'kiosk_locked').length).toBe(20 - misses);
		const r = await redisReady();
		const level = Number(await r.get(rkey('kiosk-level', `${d.id}:e:${ids.dan}`)));
		expect(level).toBeLessThanOrEqual(1);
		for (const spelling of ['ID-0009', 'İD-0009', ' id-0009 '])
			expect(await code(at(NOW, () => kioskPunch(d, { code: spelling, pin: PIN.dan })))).toBe('kiosk_locked');
		const junk = 'NOPE CALL http://evil';
		await Array.from({ length: 2 * KIOSK_FAILS_BEFORE_LOCK }).reduce<Promise<unknown>>(
			async (acc) => (
				await acc,
				r.del(rkey('kiosk-lock', `${d.id}:c:${junk.toLowerCase()}`)),
				code(kioskPunch(d, { code: junk, pin: '581937' }))
			),
			Promise.resolve()
		);
		const told = await withTenant(sys(), (tx) =>
			tx.select({ title: notifications.title }).from(notifications).where(eq(notifications.category, 'kiosk'))
		);
		expect(told.some((n) => n.title.includes('evil'))).toBe(false);
	});

	it('keeps serving staff after many wrong PINs on one kiosk and tells HR once', async () => {
		const d = await device((await newKiosk('Spray')).token);
		await Promise.all(Array.from({ length: 30 }, (_, i) => code(kioskPunch(d, { code: `X-${i}`, pin: '581937' }))));
		expect(await code(at('2026-11-28T09:00:00+06:00', () => kioskPunch(d, { code: 'ID-0009', pin: PIN.dan })))).toBe(
			'ok'
		);
		const told = await withTenant(sys(), (tx) =>
			tx
				.select({ title: notifications.title })
				.from(notifications)
				.where(and(eq(notifications.membershipId, who.hr.access.membershipId), eq(notifications.category, 'kiosk')))
		);
		expect(told.filter((n) => n.title === 'Many wrong PINs at kiosk Spray')).toHaveLength(1);
	});

	it('stops a kiosk whose work site is switched off', async () => {
		const k = await newKiosk('Closed site');
		const d = await device(k.token);
		await ownerPool().sql`update work_sites set active = false where id = ${d.siteId}`;
		try {
			expect(await kioskDevice(k.token, null)).toBeNull();
		} finally {
			await ownerPool().sql`update work_sites set active = true where id = ${d.siteId}`;
		}
	});

	it('clears the kiosk PIN and the payslip password at the same time without errors', async () => {
		const rounds = await Array.from({ length: 10 }).reduce<Promise<string[]>>(async (acc) => {
			const done = await acc;
			await ownerPool().sql`
				insert into member_secrets (tenant_id, membership_id, pdf_password_enc, kiosk_pin_mac)
				values (${tenant.id}, ${who.bea.access.membershipId}, 'pdf', 'k:mac')
				on conflict (tenant_id, membership_id) do update set pdf_password_enc = 'pdf', kiosk_pin_mac = 'k:mac'`;
			const both = await Promise.all([code(removeKioskPin(who.bea)), code(removePdfPassword(who.bea))]);
			const left = await ownerPool()
				.sql`select 1 from member_secrets where membership_id = ${who.bea.access.membershipId}`;
			return [...done, ...both, left.length ? 'left' : 'gone'];
		}, Promise.resolve([]));
		expect(new Set(rounds)).toEqual(new Set(['ok', 'gone']));
		expect(await code(setPin('bea'))).toBe('ok');
	});

	it('refuses to check PINs when Redis is down', async () => {
		const d = await device((await newKiosk('No redis')).token);
		redisDown.on = true;
		try {
			expect(await code(at('2026-11-27T09:00:00+06:00', () => kioskPunch(d, { code: codes.ana, pin: PIN.ana })))).toBe(
				'kiosk_unavailable'
			);
		} finally {
			redisDown.on = false;
		}
		expect((await punches(ids.ana)).filter((p) => p.at.toISOString().startsWith('2026-11-27'))).toHaveLength(0);
	});
});
