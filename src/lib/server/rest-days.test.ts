import { describe, expect, it } from 'vitest';
import { restDays } from './rest-days';

describe('restDays', () => {
	const rest = restDays(
		[5, 6],
		[
			{ employeeId: 'a', effectiveFrom: '2026-03-01', weekendDays: [0, 6] },
			{ employeeId: 'a', effectiveFrom: '2026-03-15', weekendDays: [] },
			{ employeeId: 'b', effectiveFrom: '2026-03-10', weekendDays: [1] }
		]
	);

	it('uses the company weekend for people without a work week', () => {
		expect([rest('z', '2026-03-06'), rest('z', '2026-03-07'), rest('z', '2026-03-08')]).toEqual([true, true, false]);
	});

	it('uses the company weekend before the first work week starts', () => {
		expect([rest('a', '2026-02-27'), rest('a', '2026-02-22'), rest('b', '2026-03-06')]).toEqual([true, false, true]);
	});

	it('uses the latest work week that has started', () => {
		expect([rest('a', '2026-03-06'), rest('a', '2026-03-07'), rest('a', '2026-03-08')]).toEqual([false, true, true]);
		expect([rest('a', '2026-03-15'), rest('a', '2026-03-21'), rest('a', '2026-03-22')]).toEqual([false, false, false]);
		expect([rest('b', '2026-03-09'), rest('b', '2026-03-16'), rest('b', '2026-03-13')]).toEqual([false, true, false]);
	});
});
