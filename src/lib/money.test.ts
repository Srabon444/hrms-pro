import { expect, it } from 'vitest';
import { poishaOf, taka } from './money';

it('converts taka text to whole poisha and back', () => {
	expect(['0.29', '12', '12.5', '12.05', '99999.99'].map(poishaOf)).toEqual([29, 1200, 1250, 1205, 9999999]);
	expect([29, 1200, 1250, 5].map(taka)).toEqual(['0.29', '12.00', '12.50', '0.05']);
});
