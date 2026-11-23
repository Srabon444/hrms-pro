import { expect, it } from 'vitest';
import { employeeShare, poishaOf, taka } from './money';

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
