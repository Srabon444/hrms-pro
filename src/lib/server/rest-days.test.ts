import { describe, expect, it } from 'vitest';
import { dayRule, restDays } from './rest-days';

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

describe('dayRule', () => {
	const shift = (id: string, isDefault = false) =>
		({ id, name: id, startTime: '09:00:00', endTime: '18:00:00', isDefault, active: true }) as never;
	const rule = dayRule(
		[5, 6],
		[
			{ employeeId: 'r', effectiveFrom: '2026-03-01', weekendDays: [5], rosterMode: true },
			{ employeeId: 'a', effectiveFrom: '2026-03-01', weekendDays: [5, 6], rosterMode: false }
		],
		[shift('day', true), shift('night')],
		[{ employeeId: 'a', effectiveFrom: '2026-03-01', shiftId: 'night' }],
		[
			{ employeeId: 'a', date: '2026-03-06', kind: 'work', shiftId: 'day' },
			{ employeeId: 'a', date: '2026-03-09', kind: 'off', shiftId: null },
			{ employeeId: 'r', date: '2026-03-10', kind: 'work', shiftId: 'night' }
		]
	);
	const view = (e: string, d: string) => {
		const r = rule(e, d);
		return [r.shift?.id, r.rostered, r.rest, r.rosterRest];
	};

	it('falls back to the assigned shift and the work week without an entry', () => {
		expect(view('a', '2026-03-10')).toEqual(['night', null, false, false]);
		expect(view('a', '2026-03-07')).toEqual(['night', null, true, false]);
		expect(view('z', '2026-03-10')).toEqual(['day', null, false, false]);
	});

	it('makes a rostered shift a working day even on the weekend', () => {
		expect(view('a', '2026-03-06')).toEqual(['day', 'work', false, false]);
	});

	it('makes a rostered day off a rest day that leave can still cover', () => {
		expect(view('a', '2026-03-09')).toEqual(['night', 'off', true, true]);
	});

	it('rests everyone in roster mode on days without a shift', () => {
		expect(view('r', '2026-03-09')).toEqual(['day', null, true, true]);
		expect(view('r', '2026-03-06')).toEqual(['day', null, true, false]);
		expect(view('r', '2026-03-10')).toEqual(['night', 'work', false, false]);
	});
});
