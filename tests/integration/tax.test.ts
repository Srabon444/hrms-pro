import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { employees, employeeTaxProfiles, memberships, taxSlabs, taxYears } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import {
	confirmTaxYear,
	saveTaxProfile,
	saveTaxYear,
	startTaxYear,
	taxBoard,
	taxCtx,
	taxRule
} from '../../src/lib/server/tax';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { DEFAULT_TAX_YEAR, fiscalYearOf } from '../../src/lib/tax';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const code = (p: Promise<unknown>) =>
	p
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

const yearId = async (fy: string) =>
	(await withTenant(sys(), (tx) => tx.select().from(taxYears).where(eq(taxYears.fy, fy))))[0]?.id;
const rules = (taxYearId: string, extra: Record<string, string> = {}) => ({
	taxYearId,
	minimumTax: '3000',
	exemptionCap: '500000',
	exemptionDivisor: '3',
	bands_general: '300000 0\n100000 10\nrest 20',
	bands_female_senior: '400000 0\nrest 20',
	bands_disabled: '450000 0\nrest 20',
	bands_freedom_fighter: '500000 0\nrest 20',
	...extra
});
const profile = (taxYearId: string, employeeId: string, extra: Record<string, string> = {}) => ({
	taxYearId,
	employeeId,
	category: 'female_senior',
	prevEmployerIncome: '120000',
	prevTaxPaid: '2500.50',
	rebate: '10000',
	...extra
});

beforeAll(async () => {
	tenant = await createTenant('tax');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.ana = await hire('Ana');
	ids.gone = await hire('Gone');
	await withTenant(sys(), (tx) =>
		tx.update(employees).set({ status: 'exited', exitDate: '2026-02-01' }).where(eq(employees.id, ids.gone))
	);
	await member('admin', ['hr_admin'], null);
	await member('po', ['payroll_officer'], null);
});

afterAll(closePools);

describe('tax years', () => {
	it('seeds the first year unconfirmed and copies later years from the latest one', async () => {
		expect(await code(startTaxYear(who.admin, { fy: '2026-28' }))).toBe('bad_fy');
		expect(await code(startTaxYear(who.admin, { fy: '26-27' }))).toMatch(/like 2026-27/);
		const first = await startTaxYear(who.admin, { fy: '2025-26' });
		expect(await code(startTaxYear(who.admin, { fy: '2025-26' }))).toBe('exists');
		await withTenant(sys(), async (tx) => {
			const [y] = await tx.select().from(taxYears).where(eq(taxYears.id, first));
			expect(y).toMatchObject({
				minimumTax: DEFAULT_TAX_YEAR.minimumTax,
				exemptionCap: DEFAULT_TAX_YEAR.exemptionCap,
				exemptionDivisor: 3,
				confirmedAt: null
			});
			expect(await tx.select().from(taxSlabs).where(eq(taxSlabs.taxYearId, first))).toHaveLength(28);
		});
		expect(await withTenant(sys(), (tx) => taxRule(tx, '2025-26', 'general'))).toBeNull();

		await saveTaxYear(who.admin, rules(first));
		const second = await startTaxYear(who.admin, { fy: '2026-27' });
		const rule = await withTenant(sys(), async (tx) => {
			await confirmTaxYear(who.admin, { taxYearId: second });
			return taxRule(tx, '2026-27', 'general');
		});
		expect(rule).toMatchObject({ minimumTax: 300000, exemptionCap: 50000000, exemptionDivisor: 3 });
		expect(rule!.bands).toEqual([
			{ width: 30000000, rateBp: 0 },
			{ width: 10000000, rateBp: 1000 },
			{ width: null, rateBp: 2000 }
		]);
		expect(
			(await withTenant(sys(), (tx) => taxRule(tx, '2026-27', 'female_senior')))!.bands.map((b) => b.width)
		).toEqual([40000000, null]);
		expect(await withTenant(sys(), (tx) => taxRule(tx, '2030-31', 'general'))).toBeNull();
	});

	it('validates rules and clears the confirmation on every save', async () => {
		const id = (await yearId('2026-27'))!;
		expect(await code(saveTaxYear(who.admin, rules(id, { bands_disabled: '100 5' })))).toBe('bad_bands');
		expect(await code(saveTaxYear(who.admin, rules(id, { bands_freedom_fighter: '' })))).toBe('bad_bands');
		expect(await code(saveTaxYear(who.admin, rules(id, { exemptionDivisor: '0' })))).toMatch(/between 1 and 10/);
		expect(await code(saveTaxYear(who.admin, rules(id, { exemptionDivisor: '11' })))).toMatch(/between 1 and 10/);
		expect(await code(saveTaxYear(who.admin, rules(id, { minimumTax: '-1' })))).toMatch(/minimum tax/);
		expect(await code(saveTaxYear(who.admin, rules(crypto.randomUUID())))).toBe('not_found');
		expect(await code(confirmTaxYear(who.admin, { taxYearId: crypto.randomUUID() }))).toBe('not_found');
		expect(await withTenant(sys(), (tx) => taxRule(tx, '2026-27', 'general'))).not.toBeNull();
		await saveTaxYear(who.admin, rules(id, { bands_general: '200000 0\nrest 15' }));
		expect(await withTenant(sys(), (tx) => taxRule(tx, '2026-27', 'general'))).toBeNull();
		await confirmTaxYear(who.admin, { taxYearId: id });
		expect((await withTenant(sys(), (tx) => taxRule(tx, '2026-27', 'general')))!.bands).toEqual([
			{ width: 20000000, rateBp: 0 },
			{ width: null, rateBp: 1500 }
		]);
		const [y] = await withTenant(sys(), (tx) => tx.select().from(taxYears).where(eq(taxYears.id, id)));
		expect(y.confirmedByUserId).toBe(who.admin.user.userId);
	});
});

describe('tax profiles', () => {
	it('upserts one profile per employee and year, visible only with payroll access', async () => {
		const id = (await yearId('2026-27'))!;
		await saveTaxProfile(who.po, profile(id, ids.ana));
		await saveTaxProfile(who.po, profile(id, ids.ana, { rebate: '15000' }));
		const rows = await withTenant(taxCtx(who.po), (tx) =>
			tx.select().from(employeeTaxProfiles).where(eq(employeeTaxProfiles.employeeId, ids.ana))
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			category: 'female_senior',
			prevEmployerIncome: 12000000,
			prevTaxPaid: 250050,
			rebate: 1500000
		});
		expect(await withTenant(userCtx(who.admin), (tx) => tx.select().from(employeeTaxProfiles))).toEqual([]);
		expect(await code(saveTaxProfile(who.po, profile(id, crypto.randomUUID())))).toBe('not_found');
		expect(await code(saveTaxProfile(who.po, profile(crypto.randomUUID(), ids.ana)))).toBe('not_found');
		expect(await code(saveTaxProfile(who.po, profile(id, ids.ana, { category: 'vip' })))).toMatch(/tax category/);
		expect(await code(saveTaxProfile(who.po, profile(id, ids.ana, { rebate: '1.234' })))).toMatch(/rebate/);
		const narrow = { ...who.po, access: { ...who.po.access, grants: { 'payroll.run': ['own'] } } } as Member;
		expect(await code(saveTaxProfile(narrow, profile(id, ids.ana)))).toBe('not_found');
	});

	it('builds the board for the chosen or current year', async () => {
		const po = await withTenant(taxCtx(who.po), (tx) => taxBoard(tx, who.po, '2026-27'));
		expect(po.canConfigure).toBe(false);
		expect(po.canProfiles).toBe(true);
		expect(po.years).toEqual([
			{ fy: '2026-27', confirmed: true },
			{ fy: '2025-26', confirmed: false }
		]);
		expect(po.year!.bands.general).toBe('200000 0\nrest 15');
		expect(po.people.map((p) => p.name)).toEqual(['Ana']);
		expect(po.people[0]).toMatchObject({ category: 'female_senior', rebate: 1500000 });
		const old = await withTenant(taxCtx(who.po), (tx) => taxBoard(tx, who.po, '2025-26'));
		expect(old.people[0]).toMatchObject({ name: 'Ana', category: null });
		const admin = await withTenant(taxCtx(who.admin), (tx) => taxBoard(tx, who.admin, 'nope'));
		expect(admin.canConfigure).toBe(true);
		expect(taxCtx(who.admin).payrollAll).toBe(false);
		expect(taxCtx(who.po).payrollAll).toBe(true);
		expect(admin.year!.fy).toBe('2026-27');
		expect(admin.current).toBe(fiscalYearOf(new Date().toISOString().slice(0, 10)));
	});
});
