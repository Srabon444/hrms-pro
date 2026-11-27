import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { punch, teamDay, todayPunches } from '../../src/lib/server/attendance';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { attendanceDays, attendancePunches, branches, memberships } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { assignShift, createShift, listShifts } from '../../src/lib/server/shifts';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { listWorkSites, savePunchRule, saveWorkSite } from '../../src/lib/server/work-sites';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let tenant: Tenant;
let other: Tenant;
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = (t = tenant) => systemCtx(t.id);
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
const hire = (fullName: string, extra: Record<string, string> = {}) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01',
		...extra
	});

async function member(key: string, roleKeys: string[], employeeId: string) {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const at = <T>(iso: string, fn: () => Promise<T>) => withTestNow(`${iso}+06:00`, fn);
const punchAt = (key: string, iso: string, ip: string | null, form: Record<string, string> = {}) =>
	at(iso, () => code(punch(who[key], ip, form)));
const lastPunch = (employeeId: string) =>
	withTenant(sys(), async (tx) => {
		const rows = await tx
			.select()
			.from(attendancePunches)
			.where(eq(attendancePunches.employeeId, employeeId))
			.orderBy(asc(attendancePunches.at));
		return rows.at(-1);
	});
const site = (raw: Record<string, string>, siteId = '', t = tenant) =>
	code(
		saveWorkSite(ctx(t), siteId, {
			name: 'HQ',
			branchId: '',
			lat: '',
			lng: '',
			radiusM: '200',
			ipCidrs: '',
			active: 'on',
			...raw
		})
	);
const HQ = { lat: '23.7808', lng: '90.4074' };

beforeAll(async () => {
	tenant = await createTenant('timeclock');
	other = await createTenant('timeclockb');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(sys(other), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	const [dhaka, ctg] = await withTenant(sys(), (tx) =>
		tx
			.insert(branches)
			.values([
				{ tenantId: tenant.id, name: 'Dhaka' },
				{ tenantId: tenant.id, name: 'Chattogram' }
			])
			.returning({ id: branches.id })
	);
	ids.dhaka = dhaka.id;
	ids.ctg = ctg.id;
	ids.hr = await hire('HR', { branchId: dhaka.id });
	ids.ana = await hire('Ana', { branchId: dhaka.id });
	ids.cal = await hire('Cal', { branchId: ctg.id });
	ids.bea = await hire('Bea', { branchId: dhaka.id });
	await member('hr', ['hr_admin'], ids.hr);
	await member('ana', ['employee'], ids.ana);
	await member('cal', ['employee'], ids.cal);
	await member('bea', ['employee'], ids.bea);
	await createShift(ctx(), {
		name: 'Lunch',
		startTime: '09:00',
		endTime: '18:00',
		graceMinutes: '15',
		halfDayMinutes: '240',
		fullDayMinutes: '480',
		breakMinutes: '60',
		active: 'on'
	});
	const lunch = (await withTenant(sys(), listShifts)).find((s) => s.name === 'Lunch')!;
	await assignShift(who.hr, ids.bea, { shiftId: lunch.id, effectiveFrom: '2026-03-01' });
});

afterAll(closePools);

describe('work sites', () => {
	it('checks every field and the branch before saving', async () => {
		expect(await code(savePunchRule(ctx(), 'block'))).toBe('no_sites');
		expect(await code(savePunchRule(ctx(), 'everywhere'))).toBe('invalid');
		expect(await site({ name: 'Nothing' })).toBe('invalid');
		expect(await site({ lat: '23.7' })).toBe('invalid');
		expect(await site({ lat: '91', lng: '90' })).toBe('invalid');
		expect(await site({ ...HQ, radiusM: '10' })).toBe('invalid');
		expect(await site({ ipCidrs: '10.0.0.0/33' })).toBe('invalid');
		expect(await site({ ipCidrs: "1.2.3.4'; drop table x" })).toBe('invalid');
		expect(await site({ ipCidrs: Array.from({ length: 21 }, (_, i) => `10.0.${i}.0/24`).join('\n') })).toBe('invalid');
		expect(await site({ ...HQ, branchId: crypto.randomUUID() })).toBe('invalid');
		expect(await site({ ipCidrs: 'fe80::1%eth0/64' })).toBe('invalid');
		expect(await site({ ipCidrs: 'fe80::1%eth0' })).toBe('invalid');
		expect(await site({ ipCidrs: '2001:db8::1/064' })).toBe('invalid');
		expect(await site({ ipCidrs: '10.0.0.0/010' })).toBe('invalid');
		expect(await site({ ...HQ, ipCidrs: '203.0.113.77/24\n2001:db8::1/48' })).toBe('ok');
		expect(await site({ name: 'HQ', ipCidrs: '10.0.0.0/8' })).toBe('duplicate');
		expect(await site({ name: 'Port', branchId: ids.ctg, ipCidrs: '198.51.100.0/24' })).toBe('ok');
		const sites = await withTenant(sys(), listWorkSites);
		expect(sites.find((s) => s.name === 'HQ')).toMatchObject({
			lat: 23.7808,
			radiusM: 200,
			ipCidrs: ['203.0.113.0/24', '2001:db8::/48']
		});
	});

	it('keeps punch locations out while the rule is off', async () => {
		expect(await punchAt('ana', '2026-03-10T09:00:00', '192.0.2.1', { ...HQ, accuracy: '20' })).toBe('ok');
		expect(await lastPunch(ids.ana)).toMatchObject({ lat: null, lng: null, siteId: null, outsideSite: false });
	});

	it('flags punches away from a site and lets HR see them', async () => {
		expect(await code(savePunchRule(ctx(), 'flag'))).toBe('ok');
		await site({ name: 'Everywhere', ipCidrs: '0.0.0.0/0' }, '', other);
		expect(await punchAt('ana', '2026-03-10T18:00:00', '192.0.2.1')).toBe('ok');
		expect(await lastPunch(ids.ana)).toMatchObject({ siteId: null, outsideSite: true, ip: '192.0.2.1' });
		const team = await at('2026-03-10T19:00:00', () =>
			withTenant(sys(), (tx) => teamDay(tx, who.hr.access, '2026-03-10'))
		);
		expect(team.find((t) => t.id === ids.ana)).toMatchObject({ outsideSite: true });
		expect(team.find((t) => t.id === ids.cal)).toMatchObject({ outsideSite: false });

		const hq = (await withTenant(sys(), listWorkSites)).find((s) => s.name === 'HQ')!;
		expect(await punchAt('ana', '2026-03-11T09:00:00', '::ffff:203.0.113.9')).toBe('ok');
		expect(await lastPunch(ids.ana)).toMatchObject({ siteId: hq.id, outsideSite: false, ip: '203.0.113.9' });
		expect(
			await punchAt('ana', '2026-03-11T18:00:00', '192.0.2.1', { lat: '23.7820', lng: '90.4074', accuracy: '30' })
		).toBe('ok');
		expect(await lastPunch(ids.ana)).toMatchObject({ siteId: hq.id, outsideSite: false, lat: 23.782, accuracyM: 30 });
		expect(
			await punchAt('ana', '2026-03-12T09:00:00', '192.0.2.1', { lat: '23.80', lng: '90.4074', accuracy: '5000' })
		).toBe('ok');
		expect(await lastPunch(ids.ana)).toMatchObject({ siteId: null, outsideSite: true });
	});

	it('treats an address Postgres cannot read as off the network', async () => {
		expect(await punchAt('hr', '2026-03-10T09:00:00', 'fe80::1%eth0')).toBe('ok');
		expect(await lastPunch(ids.hr)).toMatchObject({ siteId: null, outsideSite: true });
	});

	it('only matches sites of the employee branch or of every branch', async () => {
		expect(await punchAt('ana', '2026-03-12T18:00:00', '198.51.100.4')).toBe('ok');
		expect(await lastPunch(ids.ana)).toMatchObject({ outsideSite: true });
		expect(await punchAt('cal', '2026-03-12T09:00:00', '198.51.100.4')).toBe('ok');
		expect(await lastPunch(ids.cal)).toMatchObject({ outsideSite: false });
		expect(await punchAt('cal', '2026-03-12T18:00:00', '203.0.113.9')).toBe('ok');
		expect(await lastPunch(ids.cal)).toMatchObject({ outsideSite: false });
	});

	it('refuses to block while anyone has no site for their branch', async () => {
		const sites = await withTenant(sys(), listWorkSites);
		const hq = sites.find((x) => x.name === 'HQ')!;
		const off = {
			name: 'HQ',
			branchId: ids.dhaka,
			lat: HQ.lat,
			lng: HQ.lng,
			radiusM: '200',
			ipCidrs: hq.ipCidrs.join('\n'),
			active: 'on'
		};
		expect(await code(saveWorkSite(ctx(), hq.id, off))).toBe('ok');
		expect(await code(savePunchRule(ctx(), 'block'))).toBe('ok');
		const port = sites.find((x) => x.name === 'Port')!;
		const portRaw = {
			name: 'Port',
			branchId: ids.ctg,
			lat: '',
			lng: '',
			radiusM: '200',
			ipCidrs: port.ipCidrs.join('\n'),
			active: ''
		};
		expect(await code(saveWorkSite(ctx(), port.id, portRaw))).toBe('no_sites');
		expect(await code(saveWorkSite(ctx(), hq.id, { ...off, branchId: ids.ctg }))).toBe('no_sites');
		expect(await code(saveWorkSite(ctx(), hq.id, { ...off, branchId: '' }))).toBe('ok');
		expect(await code(savePunchRule(ctx(), 'flag'))).toBe('ok');
	});

	it('refuses punches away from a site once the rule blocks them', async () => {
		expect(await code(savePunchRule(ctx(), 'block'))).toBe('ok');
		const before = await lastPunch(ids.ana);
		expect(await punchAt('ana', '2026-03-13T09:00:00', '192.0.2.1', { lat: '0', lng: '0', accuracy: '10' })).toBe(
			'outside_site'
		);
		expect(await punchAt('ana', '2026-03-13T09:01:00', 'not-an-ip')).toBe('outside_site');
		expect((await lastPunch(ids.ana))?.id).toBe(before?.id);
		expect(await punchAt('ana', '2026-03-13T09:02:00', '2001:db8::5')).toBe('ok');
		const sites = await withTenant(sys(), listWorkSites);
		const raw = (name: string) => {
			const s = sites.find((x) => x.name === name)!;
			return {
				name,
				branchId: s.branchId ?? '',
				lat: String(s.lat ?? ''),
				lng: String(s.lng ?? ''),
				radiusM: String(s.radiusM),
				ipCidrs: s.ipCidrs.join('\n'),
				active: ''
			};
		};
		expect(await code(saveWorkSite(ctx(), sites.find((x) => x.name === 'Port')!.id, raw('Port')))).toBe('ok');
		expect(await code(saveWorkSite(ctx(), sites.find((x) => x.name === 'HQ')!.id, raw('HQ')))).toBe('no_sites');
		expect((await withTenant(sys(), listWorkSites)).find((s) => s.name === 'HQ')).toMatchObject({ active: true });
		expect(await code(savePunchRule(ctx(), 'off'))).toBe('ok');
	});
});

describe('breaks', () => {
	it('takes punched unpaid breaks off worked time', async () => {
		expect(await punchAt('bea', '2026-03-16T09:00:00', null, { kind: 'break_end' })).toBe('no_break');
		expect(await punchAt('bea', '2026-03-16T09:00:00', null, { kind: 'break_start' })).toBe('no_break');
		expect(await punchAt('bea', '2026-03-16T09:00:00', null)).toBe('ok');
		expect(await punchAt('bea', '2026-03-16T13:00:00', null, { kind: 'break_start' })).toBe('ok');
		const now = await at('2026-03-16T13:10:00', () => withTenant(sys(), (tx) => todayPunches(tx, who.bea.access)));
		expect(now).toMatchObject({ onBreak: true, clockedIn: true });
		expect(await punchAt('bea', '2026-03-16T13:10:00', null, { kind: 'break_start' })).toBe('no_break');
		expect(await punchAt('bea', '2026-03-16T13:30:00', null, { kind: 'break_end' })).toBe('ok');
		expect(await punchAt('bea', '2026-03-16T18:00:00', null)).toBe('ok');
		const [d] = await at('2026-03-16T19:00:00', () =>
			withTenant(sys(), (tx) =>
				tx
					.select()
					.from(attendanceDays)
					.where(and(eq(attendanceDays.employeeId, ids.bea), eq(attendanceDays.date, '2026-03-16')))
			)
		);
		expect(d).toMatchObject({ status: 'present', workedMinutes: 510 });
		const kinds = await withTenant(sys(), (tx) =>
			tx
				.select({ kind: attendancePunches.kind })
				.from(attendancePunches)
				.where(eq(attendancePunches.employeeId, ids.bea))
				.orderBy(asc(attendancePunches.at))
		);
		expect(kinds.map((k) => k.kind)).toEqual([null, 'break_start', 'break_end', null]);
	});

	it('takes the fixed unpaid break off a day with no break punched', async () => {
		expect(await punchAt('bea', '2026-03-17T09:00:00', null, { kind: 'whatever' })).toBe('ok');
		expect(await punchAt('bea', '2026-03-17T18:00:00', null)).toBe('ok');
		const rows = await ownerPool().sql<{ worked: number }[]>`
			select worked_minutes as worked from attendance_days where employee_id = ${ids.bea} and date = '2026-03-17'`;
		expect(rows[0].worked).toBe(480);
	});

	it('refuses a full day longer than the shift less its unpaid break', async () => {
		expect(
			await code(
				createShift(ctx(), {
					name: 'Tight',
					startTime: '09:00',
					endTime: '17:00',
					graceMinutes: '0',
					halfDayMinutes: '240',
					fullDayMinutes: '480',
					breakMinutes: '30',
					active: 'on'
				})
			)
		).toBe('invalid');
		expect(
			await code(
				createShift(ctx(), {
					name: 'Tight',
					startTime: '09:00',
					endTime: '17:00',
					graceMinutes: '0',
					halfDayMinutes: '240',
					fullDayMinutes: '480',
					breakMinutes: '30',
					breakPaid: 'on',
					active: 'on'
				})
			)
		).toBe('ok');
	});
});
