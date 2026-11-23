import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetCharges, assetList, assetView, assignAsset, returnAsset, saveAsset } from '../../src/lib/server/assets';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import { employees, memberships } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { recordExit, runTenantLifecycle } from '../../src/lib/server/exits';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const tag: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const NOW = '2026-11-24T06:00:00Z';
const code = (p: () => Promise<unknown>, now = NOW) =>
	withTestNow(now, p)
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (fullName: string) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01'
	});

async function member(key: string, roleKeys: string[], employeeId: string | null) {
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

const save = (key: string, f: Record<string, string>) =>
	code(() =>
		saveAsset(who[key], { name: 'Laptop', category: 'Laptop', ...f }).then((id) => (tag[f.tag.toUpperCase()] ??= id))
	);
const give = (key: string, t: string, e: string, assignedOn = '2026-11-01', condition = 'good') =>
	code(() => assignAsset(who[key], { assetId: tag[t], employeeId: ids[e], assignedOn, condition }));
const back = (key: string, t: string, f: Record<string, string>) =>
	code(() => returnAsset(who[key], { assetId: tag[t], returnedOn: '2026-11-20', ...f }));
const read = <T>(key: string, fn: (tx: never, access: Member['access']) => Promise<T>) =>
	withTestNow(NOW, () => withTenant(userCtx(who[key]), (tx) => fn(tx as never, who[key].access)));
const listed = async (key: string, filter = {}) =>
	(await read(key, (tx, a) => assetList(tx, a, filter))).map((x) => `${x.tag} ${x.status} ${x.holder ?? '-'}`);
const view = (key: string, t: string) => read(key, (tx, a) => assetView(tx, a, tag[t]));

beforeAll(async () => {
	tenant = await createTenant('assets');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.ana = await hire('Ana');
	ids.ben = await hire('Ben');
	ids.old = await hire('Old');
	await withTenant(sys(), (tx) => tx.update(employees).set({ status: 'exited' }).where(eq(employees.id, ids.old)));
	await member('it', ['it_asset_manager'], null);
	await member('hr', ['hr_admin'], null);
	await member('ana', [], ids.ana);
	await member('ben', [], ids.ben);
});

afterAll(closePools);

describe('asset register', () => {
	it('lets only asset managers register assets with unique tags', async () => {
		expect(
			await save('it', { tag: 'lap-001', serial: 'SN1', purchaseDate: '2026-01-10', purchaseCost: '120000.50' })
		).toBe('ok');
		expect(await save('it', { tag: 'MON-001', name: 'Monitor', category: 'Monitor' })).toBe('ok');
		expect(await save('it', { tag: 'PH-001', name: 'Phone', category: 'Phone' })).toBe('ok');
		expect(await save('it', { tag: 'LAP-001' })).toBe('tag_exists');
		expect(await save('it', { tag: 'X' })).toBe('invalid: Use 2 to 20 letters, digits or dashes for the tag.');
		expect(await save('it', { tag: 'LAP-002', purchaseCost: '1.234' })).toBe(
			'invalid: Enter the cost in taka, up to 2 decimals.'
		);
		expect(await save('it', { tag: 'LAP-003', purchaseDate: '2026-12-01' })).toBe('future');
		expect(await save('ana', { tag: 'ANA-1' })).toBe('forbidden');
		expect(await save('hr', { tag: 'HR-1' })).toBe('forbidden');
		expect(await code(() => saveAsset(who.it, { assetId: ids.ana, tag: 'NEW-1', name: 'x', category: 'y' }))).toBe(
			'not_found'
		);
		const lap = await view('it', 'LAP-001');
		expect(lap?.asset).toMatchObject({ tag: 'LAP-001', serial: 'SN1', purchaseCost: 12_000_050, status: 'available' });
	});

	it('hands an available asset to a current employee', async () => {
		expect(await give('it', 'LAP-001', 'ana')).toBe('ok');
		expect(await give('it', 'LAP-001', 'ben')).toBe('not_available');
		expect(await give('it', 'MON-001', 'old')).toBe('invalid_employee');
		expect(await give('it', 'MON-001', 'ben', '2026-11-25')).toBe('future');
		expect(await give('it', 'MON-001', 'ben', '2026-11-02', 'shiny')).toBe('invalid: Choose the condition.');
		expect(await give('ana', 'MON-001', 'ana')).toBe('forbidden');
		expect(await give('it', 'PH-001', 'ben', '2026-11-03', 'new')).toBe('ok');
		expect(await listed('it')).toEqual(['LAP-001 assigned Ana', 'MON-001 available -', 'PH-001 assigned Ben']);
	});

	it('keeps an assigned asset assigned when edited', async () => {
		expect(await save('it', { tag: 'LAP-001', assetId: tag['LAP-001'], status: 'repair' })).toBe('assigned');
		expect(await save('it', { tag: 'LAP-001', assetId: tag['LAP-001'], name: 'Laptop 14' })).toBe('ok');
		expect((await view('it', 'LAP-001'))?.asset).toMatchObject({ name: 'Laptop 14', status: 'assigned' });
		expect(await save('it', { tag: 'MON-001', assetId: tag['MON-001'], name: 'Monitor', status: 'repair' })).toBe('ok');
		expect((await view('it', 'MON-001'))?.asset.status).toBe('repair');
		expect(await give('it', 'MON-001', 'ben')).toBe('not_available');
		expect(await save('it', { tag: 'MON-001', assetId: tag['MON-001'], name: 'Monitor' })).toBe('ok');
		expect((await view('it', 'MON-001'))?.asset.status).toBe('repair');
		expect(await save('it', { tag: 'MON-001', assetId: tag['MON-001'], name: 'Monitor', status: 'available' })).toBe(
			'ok'
		);
	});

	it('shows employees only what they hold and HR everything', async () => {
		expect(await listed('ana')).toEqual(['LAP-001 assigned Ana']);
		expect(await listed('ben')).toEqual(['PH-001 assigned Ben']);
		expect(await listed('hr')).toHaveLength(3);
		expect(await listed('it', { status: 'available' })).toEqual(['MON-001 available -']);
		expect(await listed('it', { q: 'top 14' })).toEqual(['LAP-001 assigned Ana']);
		expect(await view('ben', 'LAP-001')).toBeNull();
		const mine = await view('ana', 'LAP-001');
		expect([mine?.holder, mine?.canManage, mine?.people]).toEqual([ids.ana, false, []]);
	});

	it('takes assets back with their condition, or writes them off with a reason', async () => {
		expect(await back('it', 'MON-001', { outcome: 'returned', condition: 'good' })).toBe('not_assigned');
		expect(await back('it', 'LAP-001', { outcome: 'returned' })).toBe('invalid: Choose the condition it came back in.');
		expect(await back('it', 'LAP-001', { outcome: 'written_off' })).toBe('invalid: Say what happened to the asset.');
		expect(await back('it', 'LAP-001', { outcome: 'returned', condition: 'good', returnedOn: '2026-10-31' })).toBe(
			'before_assigned'
		);
		expect(await back('it', 'LAP-001', { outcome: 'returned', condition: 'good', returnedOn: '2026-11-25' })).toBe(
			'future'
		);
		expect(await back('ana', 'LAP-001', { outcome: 'returned', condition: 'good' })).toBe('forbidden');
		expect(await back('it', 'LAP-001', { outcome: 'returned', condition: 'damaged', charge: '500' })).toBe('ok');
		expect((await view('it', 'LAP-001'))?.asset.status).toBe('repair');
		expect(await listed('ana')).toEqual([]);
		expect(await save('it', { tag: 'LAP-001', assetId: tag['LAP-001'], name: 'Laptop 14', status: 'available' })).toBe(
			'ok'
		);
		expect(await give('it', 'LAP-001', 'ben', '2026-11-21')).toBe('ok');
		const history = (await view('it', 'LAP-001'))!.history;
		expect(history.map((h) => [h.name, h.assignedOn, h.returnedOn, h.conditionIn, h.charge])).toEqual([
			['Ben', '2026-11-21', null, null, 0],
			['Ana', '2026-11-01', '2026-11-20', 'damaged', 50_000]
		]);
		expect((await view('ben', 'LAP-001'))!.history.map((h) => h.name)).toEqual(['Ben']);
	});
});

describe('offboarding', () => {
	it('blocks an exit while the leaver still holds assets', async () => {
		const exit = (exitDate: string) =>
			code(() => recordExit(who.hr, ids.ben, { exitDate, exitType: 'resignation', exitReason: '' }));
		expect(await exit('2026-11-24')).toBe('assets_out');
		expect(await exit('2026-11-30')).toBe('ok');
		const status = async () =>
			(await withTenant(sys(), (tx) => tx.select().from(employees).where(eq(employees.id, ids.ben))))[0].status;
		await withTestNow('2026-12-02T06:00:00Z', () => runTenantLifecycle(tenant));
		expect(await status()).toBe('notice');
		expect(await back('it', 'LAP-001', { outcome: 'returned', condition: 'good', returnedOn: '2026-11-24' })).toBe(
			'ok'
		);
		expect(
			await back('it', 'PH-001', { outcome: 'written_off', condition: 'poor', note: 'Not returned', charge: '1500.50' })
		).toBe('ok');
		expect((await view('it', 'PH-001'))?.asset.status).toBe('lost');
		await withTestNow('2026-12-02T06:00:00Z', () => runTenantLifecycle(tenant));
		expect(await status()).toBe('exited');
		expect(await withTenant(sys(), (tx) => assetCharges(tx, ids.ben))).toBe(150_050);
		expect(await withTenant(sys(), (tx) => assetCharges(tx, ids.ana))).toBe(50_000);
	});
});
