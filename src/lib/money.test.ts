import { expect, it } from 'vitest';
import { CURRENCIES, employeeShare, instalmentPlan, mealCharge, money, poishaOf, taka, unit } from './money';

it('converts taka text to whole poisha and back', () => {
	expect(['0.29', '12', '12.5', '12.05', '99999.99'].map(poishaOf)).toEqual([29, 1200, 1250, 1205, 9999999]);
	expect([29, 1200, 1250, 5].map(taka)).toEqual(['0.29', '12.00', '12.50', '0.05']);
});

it('rounds the employee share of a plate to the nearest poisha', () => {
	expect([employeeShare(8050, 50), employeeShare(8051, 50), employeeShare(8053, 50), employeeShare(999, 0)]).toEqual([
		4025, 4026, 4027, 999
	]);
	expect(employeeShare(8000, 100)).toBe(0);
});

it('charges the employee share for their plate and the full price per guest', () => {
	expect(mealCharge(true, 0, 8051, 50)).toBe(4026);
	expect(mealCharge(true, 2, 8051, 50)).toBe(4026 + 16102);
	expect(mealCharge(false, 1, 8051, 50)).toBe(8051);
	expect(mealCharge(false, 0, 8051, 50)).toBe(0);
	expect(mealCharge(true, 1, 8000, 100)).toBe(8000);
});

it('splits a loan into whole-taka instalments with the remainder last', () => {
	expect(instalmentPlan(1000000, 3)).toEqual([333300, 333300, 333400]);
	expect(instalmentPlan(1000050, 4)).toEqual([250000, 250000, 250000, 250050]);
	expect(instalmentPlan(50000, 1)).toEqual([50000]);
	expect(instalmentPlan(500, 6)).toEqual([0, 0, 0, 0, 0, 500]);
	expect(instalmentPlan(1234567, 12).reduce((a, b) => a + b)).toBe(1234567);
});

it('formats money with the tenant currency, falling back to the code for currencies without a glyph', () => {
	expect(money(1234550, 'BDT')).toBe('৳12345.50');
	expect(money(5, 'USD')).toBe('$0.05');
	expect(money(100, 'INR')).toBe('INR 1.00');
	expect([unit('EUR'), unit('GBP'), unit('AED')]).toEqual(['€', '£', 'AED']);
	expect(Object.keys(CURRENCIES)).toContain('NPR');
});
