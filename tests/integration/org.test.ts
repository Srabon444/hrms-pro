import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePools } from '../../src/lib/server/db';
import { departments } from '../../src/lib/server/db/schema';
import { advisoryLock, LOCK } from '../../src/lib/server/locks';
import { addHoliday, addOrgItem, removeOrgItem, updateOrgItem } from '../../src/lib/server/org';
import { seedTenant } from '../../src/lib/server/platform/tenants';
import { readSettings, saveSection, saveSettings, type SettingsInput } from '../../src/lib/server/settings';
import { SETTING_SECTIONS, type SectionId } from '../../src/lib/settings-sections';
import { withTenant, type TenantCtx } from '../../src/lib/server/tenancy';
import { createTenant, TEST_LOCALE } from './helpers';

let a: TenantCtx;
let b: TenantCtx;

const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));

beforeAll(async () => {
	for (const prefix of ['org-a', 'org-b']) {
		const t = await createTenant(prefix);
		await withTenant({ tenantId: t.id, actor: 'system' }, (tx) => seedTenant(tx, t.id, TEST_LOCALE));
		const ctx: TenantCtx = { tenantId: t.id, actor: 'system' };
		if (prefix === 'org-a') a = ctx;
		else b = ctx;
	}
});

afterAll(closePools);

describe('organisation structure', () => {
	it('refuses a department loop at any depth', async () => {
		const eng = await addOrgItem(a, 'department', { name: 'Engineering' });
		const web = await addOrgItem(a, 'department', { name: 'Web', parentId: eng });
		const fe = await addOrgItem(a, 'department', { name: 'Frontend', parentId: web });
		expect(await code(updateOrgItem(a, 'department', eng, { name: 'Engineering', parentId: fe }))).toBe(
			'department_cycle'
		);
		expect(await code(updateOrgItem(a, 'department', eng, { name: 'Engineering', parentId: eng }))).toBe(
			'department_cycle'
		);
		expect(await code(updateOrgItem(a, 'department', fe, { name: 'Frontend', parentId: eng }))).toBe('ok');
	});

	it('refuses concurrent moves that would form a loop', async () => {
		const x = await addOrgItem(a, 'department', { name: 'Race X' });
		const y = await addOrgItem(a, 'department', { name: 'Race Y' });
		const slowMove = withTenant(a, async (tx) => {
			await advisoryLock(tx, LOCK.orgTree, a.tenantId);
			await tx.update(departments).set({ parentId: y }).where(eq(departments.id, x));
			await new Promise((r) => setTimeout(r, 300));
		});
		await new Promise((r) => setTimeout(r, 50));
		const second = code(updateOrgItem(a, 'department', y, { name: 'Race Y', parentId: x }));
		await slowMove;
		expect(await second).toBe('department_cycle');
	});

	it('does not accept a parent from another organisation', async () => {
		const foreign = await addOrgItem(b, 'department', { name: 'Foreign' });
		expect(await code(addOrgItem(a, 'department', { name: 'Child', parentId: foreign }))).toBe('parent_not_found');
	});

	it('reports duplicates and records still in use', async () => {
		await addOrgItem(a, 'branch', { name: 'Dhaka HQ' });
		expect(await code(addOrgItem(a, 'branch', { name: 'Dhaka HQ' }))).toBe('duplicate');
		expect(await code(addOrgItem(b, 'branch', { name: 'Dhaka HQ' }))).toBe('ok');
		const parent = await addOrgItem(a, 'department', { name: 'Parent dept' });
		await addOrgItem(a, 'department', { name: 'Child dept', parentId: parent });
		expect(await code(removeOrgItem(a, 'department', parent))).toBe('in_use');
		expect(await code(removeOrgItem(a, 'grade', crypto.randomUUID()))).toBe('not_found');
		expect(await code(addOrgItem(a, 'designation', { name: '   ' }))).toBe('invalid');
	});

	it('keeps one holiday per date', async () => {
		expect(await code(addHoliday(a, { date: '2026-12-16', name: 'Victory Day' }))).toBe('ok');
		expect(await code(addHoliday(a, { date: '2026-12-16', name: 'Again' }))).toBe('duplicate');
		expect(await code(addHoliday(a, { date: '2026-02-30', name: 'Bad' }))).toBe('invalid');
	});
});

describe('organisation settings', () => {
	const base: SettingsInput = {
		legalName: 'Acme Ltd',
		address: '',
		timezone: 'Asia/Dhaka',
		currency: 'USD',
		fiscalYearStartMonth: '7',
		weekendDays: ['5', '6', '5'],
		employeeCodePrefix: 'ACM-'
	};
	const security = {
		require2faForSensitive: 'on',
		allowSingleAdminApproval: '',
		invitationValidDays: '7',
		retentionAuditDays: '730',
		retentionCandidatesDays: '180'
	};
	it('saves valid general settings and normalises weekend days', async () => {
		expect(await code(saveSettings(a, base))).toBe('ok');
		const s = await withTenant(a, readSettings);
		expect(s.weekendDays).toEqual([5, 6]);
		expect(s.employeeCodePrefix).toBe('ACM-');
		expect(s.currency).toBe('USD');
	});

	it('validates every general field on the server', async () => {
		expect(await code(saveSettings(a, { ...base, timezone: 'Mars/Base' }))).toBe('invalid');
		expect(await code(saveSettings(a, { ...base, currency: 'usd' }))).toBe('invalid');
		expect(await code(saveSettings(a, { ...base, currency: 'XYZ' }))).toBe('invalid');
		expect(await code(saveSettings(a, { ...base, weekendDays: ['0', '1', '2', '3', '4', '5', '6'] }))).toBe('invalid');
		expect(await code(saveSettings(a, { ...base, employeeCodePrefix: '<b>' }))).toBe('invalid');
	});

	it('saves a section and checks every number against its range', async () => {
		expect(await code(saveSection(a, false, 'security', security))).toBe('ok');
		const s = await withTenant(a, readSettings);
		expect(s.require2faForSensitive).toBe(true);
		expect(s.retentionCandidatesDays).toBe(180);
		for (const [id, fields] of Object.entries(SETTING_SECTIONS) as [
			SectionId,
			(typeof SETTING_SECTIONS)[SectionId]
		][]) {
			const valid = Object.fromEntries(fields.fields.map((f) => [f.key, f.kind === 'int' ? String(f.min) : '']));
			expect(await code(saveSection(a, true, id, valid))).toBe('ok');
			for (const f of fields.fields) {
				if (f.kind !== 'int') continue;
				for (const bad of [String(f.min - 1), String(f.max + 1), '', '1.5', 'x'])
					expect(await code(saveSection(a, true, id, { ...valid, [f.key]: bad })), `${f.key}=${bad}`).toBe('invalid');
			}
		}
		await expect(saveSection(a, true, 'security', { ...security, retentionAuditDays: '30' })).rejects.toThrow(
			'Keep audit history: enter 365 to 3650 days.'
		);
	});

	it('only an owner turns on single-admin approval', async () => {
		await saveSection(a, true, 'security', security);
		const on = { ...security, allowSingleAdminApproval: 'on' };
		expect(await code(saveSection(a, false, 'security', on))).toBe('owner_only');
		expect(await code(saveSection(a, true, 'security', on))).toBe('ok');
		expect(await code(saveSection(a, false, 'security', on))).toBe('ok');
	});
});
