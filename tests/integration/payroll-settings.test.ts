import { afterAll, beforeAll, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { readSettings, savePayrollSettings } from '../../src/lib/server/settings';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant } from './helpers';

let tenant: { id: string };
const valid = {
	payrollProrationBasis: 'working',
	latePolicyCount: '3',
	mealPayrollLagMonths: '0',
	pfEmployeeRateBp: '10',
	pfEmployerRateBp: '12.5',
	overtimeRateBp: '200',
	overtimeMonthlyHours: '208',
	bonusRateBp: '150.5',
	bonusMinServiceMonths: '6'
};
const reason = (raw: Record<string, string>) =>
	savePayrollSettings(systemCtx(tenant.id), raw).then(
		() => 'ok',
		(e: { issues: { message: string }[] }) => e.issues[0].message
	);

beforeAll(async () => {
	tenant = await createTenant('pset');
});
afterAll(closePools);

it('stores payroll settings in basis points and refuses values out of range', async () => {
	expect(await reason(valid)).toBe('ok');
	const s = await withTenant(systemCtx(tenant.id), readSettings);
	expect([s.payrollProrationBasis, s.latePolicyCount, s.mealPayrollLagMonths]).toEqual(['working', 3, 0]);
	expect([s.pfEmployeeRateBp, s.pfEmployerRateBp, s.overtimeRateBp, s.overtimeMonthlyHours]).toEqual([
		1000, 1250, 20000, 208
	]);
	expect([s.bonusRateBp, s.bonusMinServiceMonths]).toEqual([15050, 6]);
	expect(await reason({ ...valid, bonusRateBp: '500.01' })).toContain('festival bonus');
	expect(await reason({ ...valid, bonusMinServiceMonths: '121' })).toContain('0 to 120');
	expect(await reason({ ...valid, bonusMinServiceMonths: '1.5' })).toBe('Enter whole months.');
	expect(await reason({ ...valid, pfEmployeeRateBp: '50.01' })).toContain('employee provident fund');
	expect(await reason({ ...valid, pfEmployerRateBp: '1.234' })).toContain('employer provident fund');
	expect(await reason({ ...valid, overtimeRateBp: '500.01' })).toContain('overtime rate');
	expect(await reason({ ...valid, overtimeMonthlyHours: '0' })).toContain('1 to 744');
	expect(await reason({ ...valid, overtimeMonthlyHours: '745' })).toContain('1 to 744');
	expect(await reason({ ...valid, latePolicyCount: '32' })).toContain('0 to 31');
	expect(await reason({ ...valid, mealPayrollLagMonths: '4' })).toContain('0 to 3');
	expect(await reason({ ...valid, payrollProrationBasis: 'hours' })).toContain('part month');
	expect((await withTenant(systemCtx(tenant.id), readSettings)).pfEmployeeRateBp).toBe(1000);
});
