import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import { mealSetup, saveMealSettings, saveMealType, saveVendor, setMealPrice } from '../../src/lib/server/meals';
import { seedTenant } from '../../src/lib/server/platform/tenants';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant } from './helpers';

let tenant: { id: string; slug: string };
let other: { id: string; slug: string };
const ctx = (id = tenant.id) => ({ tenantId: id, actor: 'user' as const });
const at = <T>(iso: string, fn: () => Promise<T>) => withTestNow(`${iso}T09:00:00+06:00`, fn);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const setup = (id = tenant.id) => at('2026-03-10', () => withTenant(systemCtx(id), mealSetup));

beforeAll(async () => {
	tenant = await createTenant('meals');
	other = await createTenant('meals-other');
	for (const t of [tenant, other]) await withTenant(systemCtx(t.id), (tx) => seedTenant(tx, t.id));
});

afterAll(closePools);

describe('meal setup', () => {
	it('keeps caterers unique by name and refuses unknown ones', async () => {
		expect(await code(saveVendor(ctx(), '', { name: ' Spice Box ', contact: '01700', active: 'on' }))).toBe('ok');
		expect(await code(saveVendor(ctx(), '', { name: 'Spice Box', contact: '', active: 'on' }))).toBe('duplicate');
		expect(await code(saveVendor(ctx(), '', { name: '', contact: '', active: 'on' }))).toBe('invalid');
		expect(await code(saveVendor(ctx(), crypto.randomUUID(), { name: 'X', contact: '' }))).toBe('not_found');
		const [v] = (await setup()).vendors;
		expect(v).toMatchObject({ name: 'Spice Box', contact: '01700', active: true });
		expect(await code(saveVendor(ctx(), v.id, { name: 'Spice Box', contact: '' }))).toBe('ok');
		expect((await setup()).vendors[0]).toMatchObject({ contact: null, active: false });
		expect(await code(saveVendor(ctx(other.id), v.id, { name: 'Taken', contact: '', active: 'on' }))).toBe('not_found');
	});

	it('puts meals only with active caterers of the same company', async () => {
		const [old] = (await setup()).vendors;
		expect(await code(saveMealType(ctx(), '', { name: 'Lunch', vendorId: old.id, active: 'on' }))).toBe(
			'unknown_vendor'
		);
		await saveVendor(ctx(other.id), '', { name: 'Elsewhere', contact: '', active: 'on' });
		const [foreign] = (await setup(other.id)).vendors;
		expect(await code(saveMealType(ctx(), '', { name: 'Lunch', vendorId: foreign.id, active: 'on' }))).toBe(
			'unknown_vendor'
		);
		await saveVendor(ctx(), '', { name: 'Rice Bowl', contact: '', active: 'on' });
		const fresh = (await setup()).vendors.find((v) => v.name === 'Rice Bowl')!;
		expect(await code(saveMealType(ctx(), '', { name: 'Lunch', vendorId: fresh.id, active: 'on' }))).toBe('ok');
		expect(await code(saveMealType(ctx(), '', { name: 'Lunch', vendorId: fresh.id, active: 'on' }))).toBe('duplicate');
		const [lunch] = (await setup()).types;
		expect(lunch).toMatchObject({ name: 'Lunch', vendor: 'Rice Bowl', current: null });
		expect(await code(saveMealType(ctx(), lunch.id, { name: 'Lunch', vendorId: old.id }))).toBe('unknown_vendor');
		await saveVendor(ctx(), fresh.id, { name: 'Rice Bowl', contact: '' });
		expect(await code(saveMealType(ctx(), lunch.id, { name: 'Lunch', vendorId: fresh.id }))).toBe('ok');
		expect((await setup()).types[0].active).toBe(false);
		expect(await code(saveMealType(ctx(), crypto.randomUUID(), { name: 'X', vendorId: fresh.id }))).toBe('not_found');
	});

	it('sets prices in poisha from today onwards and replaces a price on the same date', async () => {
		const [lunch] = (await setup()).types;
		const price = (effectiveFrom: string, unitCost: string, subsidyPct = '50') =>
			code(at('2026-03-10', () => setMealPrice(ctx(), { mealTypeId: lunch.id, effectiveFrom, unitCost, subsidyPct })));
		expect(await price('2026-03-09', '80')).toBe('past_price');
		expect(await price('2026-03-10', '80.255')).toBe('invalid');
		expect(await price('2026-03-10', '0')).toBe('invalid');
		expect(await price('2026-03-10', '80', '101')).toBe('invalid');
		expect(await price('2026-03-10', '80.5')).toBe('ok');
		expect(await price('2026-04-01', '90')).toBe('ok');
		expect(await price('2026-04-01', '95', '40')).toBe('ok');
		expect(
			await code(
				at('2026-03-10', () =>
					setMealPrice(ctx(other.id), {
						mealTypeId: lunch.id,
						effectiveFrom: '2026-03-10',
						unitCost: '1',
						subsidyPct: '0'
					})
				)
			)
		).toBe('not_found');
		const t = (await setup()).types[0];
		expect(t.current).toMatchObject({ unitCost: 8050, subsidyPct: 50 });
		expect(t.prices.map((p) => [p.effectiveFrom, p.unitCost, p.subsidyPct])).toEqual([
			['2026-04-01', 9500, 40],
			['2026-03-10', 8050, 50]
		]);
	});

	it('changes how bills are paid only for people who handle billing', async () => {
		const rules = {
			mealCutoffTime: '11:30',
			mealMode: 'opt_in',
			mealWorkingDaysOnly: '',
			mealBillingMode: 'payroll',
			mealOrderDaysAhead: '21'
		};
		expect(await code(saveMealSettings(ctx(), false, rules))).toBe('ok');
		expect(await code(saveMealSettings(ctx(), false, { ...rules, mealBillingMode: 'direct' }))).toBe('forbidden');
		expect(await code(saveMealSettings(ctx(), false, { ...rules, mealMode: 'free' }))).toBe('invalid');
		expect(await code(saveMealSettings(ctx(), false, { ...rules, mealCutoffTime: '25:00' }))).toBe('invalid');
		expect(await code(saveMealSettings(ctx(), false, { ...rules, mealOrderDaysAhead: '61' }))).toBe('invalid');
		expect(await code(saveMealSettings(ctx(), true, { ...rules, mealBillingMode: 'direct' }))).toBe('ok');
		expect((await setup()).settings).toEqual({
			mealCutoffTime: '11:30:00',
			mealMode: 'opt_in',
			mealWorkingDaysOnly: false,
			mealBillingMode: 'direct',
			mealOrderDaysAhead: 21
		});
		expect((await setup(other.id)).settings.mealMode).toBe('opt_out');
	});
});
