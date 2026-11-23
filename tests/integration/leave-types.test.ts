import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { createLeaveType, listLeaveTypes, updateLeaveType } from '../../src/lib/server/leave-types';
import { seedTenant } from '../../src/lib/server/platform/tenants';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant } from './helpers';

let tenant: { id: string; slug: string };
let other: { id: string; slug: string };
const ctx = () => ({ tenantId: tenant.id, actor: 'user' as const });
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const types = (id = tenant.id) => withTenant(systemCtx(id), listLeaveTypes);
const form = (extra: Record<string, string> = {}) => ({
	name: 'Study leave',
	quota: '5',
	accrual: 'yearly',
	carryCap: '0',
	minNoticeDays: '3',
	maxConsecutive: '',
	gender: '',
	paid: 'on',
	active: 'on',
	...extra
});

beforeAll(async () => {
	tenant = await createTenant('leavetypes');
	other = await createTenant('leavetypes-other');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
	await withTenant(systemCtx(other.id), (tx) => seedTenant(tx, other.id));
});

afterAll(closePools);

describe('leave types', () => {
	it('seeds the Bangladesh defaults once per tenant', async () => {
		await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id));
		const seeded = await types();
		expect(seeded.map((t) => t.code).sort()).toEqual([
			'casual',
			'compensatory',
			'earned',
			'maternity',
			'paternity',
			'sick',
			'unpaid'
		]);
		const by = Object.fromEntries(seeded.map((t) => [t.code, t]));
		expect(by.earned).toMatchObject({
			quota: 18,
			accrual: 'monthly',
			carryCap: 60,
			encashable: true,
			duringProbation: false
		});
		expect(by.maternity).toMatchObject({ quota: 112, gender: 'female', sandwich: true, halfDayAllowed: false });
		expect(by.unpaid).toMatchObject({ paid: false, quota: null, accrual: 'none' });
	});

	it('adds a type with a unique code and name, validating every field', async () => {
		expect(await code(createLeaveType(ctx(), { ...form(), code: 'study' }))).toBe('ok');
		expect(await code(createLeaveType(ctx(), { ...form(), code: 'study' }))).toBe('duplicate');
		expect(await code(createLeaveType(ctx(), { ...form(), code: 'study_two' }))).toBe('duplicate');
		expect(await code(createLeaveType(ctx(), { ...form({ name: 'X' }), code: '9x' }))).toBe('invalid');
		for (const bad of <Record<string, string>[]>[
			{ quota: '0.3' },
			{ quota: '400' },
			{ carryCap: '-1' },
			{ accrual: 'weekly' },
			{ maxConsecutive: '0' },
			{ minNoticeDays: '366' },
			{ gender: 'other' },
			{ name: ' ' }
		])
			expect(await code(createLeaveType(ctx(), { ...form({ name: 'Y', ...bad }), code: 'yy' }))).toBe('invalid');
		const study = (await types()).find((t) => t.code === 'study')!;
		expect(study).toMatchObject({
			quota: 5,
			minNoticeDays: 3,
			maxConsecutive: null,
			gender: null,
			paid: true,
			proRata: false
		});
		expect((await types(other.id)).some((t) => t.code === 'study')).toBe(false);
	});

	it('updates a type inside the tenant only', async () => {
		const study = (await types()).find((t) => t.code === 'study')!;
		expect(
			await code(updateLeaveType(ctx(), study.id, form({ quota: '', maxConsecutive: '3', gender: 'female' })))
		).toBe('ok');
		expect((await types()).find((t) => t.code === 'study')).toMatchObject({
			quota: null,
			maxConsecutive: 3,
			gender: 'female',
			paid: true
		});
		expect(await code(updateLeaveType(ctx(), study.id, form({ name: 'Casual leave' })))).toBe('duplicate');
		expect(await code(updateLeaveType({ tenantId: other.id, actor: 'user' }, study.id, form()))).toBe('not_found');
		expect(await code(updateLeaveType(ctx(), 'nope', form()))).toBe('not_found');
	});
});
