import { describe, expect, it } from 'vitest';
import { firstWorkday, rolloverIncomplete, weekStartOf, type WorkPlanItem } from './rollover';

describe('rolloverIncomplete', () => {
	it('carries forward pending and in-progress items with a link to the original', () => {
		const items: WorkPlanItem[] = [
			{ id: '1', employeeId: 'm', description: 'Get 200 resumes', target: '200', status: 'pending' },
			{ id: '2', employeeId: 'm', description: 'Headhunt 5 devs', target: '5', status: 'in_progress' },
			{ id: '3', employeeId: 'f', description: 'Fix wifi', target: '', status: 'done' }
		];
		expect(rolloverIncomplete(items, '2026-08-23')).toEqual([
			{
				employeeId: 'm',
				description: 'Get 200 resumes',
				target: '200',
				weekStart: '2026-08-23',
				carriedOverFromId: '1'
			},
			{ employeeId: 'm', description: 'Headhunt 5 devs', target: '5', weekStart: '2026-08-23', carriedOverFromId: '2' }
		]);
	});

	it('returns an empty array when everything is done', () => {
		expect(
			rolloverIncomplete([{ id: '1', employeeId: 'f', description: 'Fix wifi', target: '', status: 'done' }], 'x')
		).toEqual([]);
	});
});

describe('weekStartOf', () => {
	it('starts the week on the first workday after the weekend', () => {
		expect(firstWorkday([5, 6])).toBe(0);
		expect(firstWorkday([0, 6])).toBe(1);
		expect(firstWorkday([5])).toBe(6);
		expect(firstWorkday([])).toBe(1);
	});

	it('maps every day of a week to its start', () => {
		expect(['2026-11-22', '2026-11-24', '2026-11-28'].map((d) => weekStartOf(d, [5, 6]))).toEqual([
			'2026-11-22',
			'2026-11-22',
			'2026-11-22'
		]);
		expect(weekStartOf('2026-11-29', [5, 6])).toBe('2026-11-29');
		expect(['2026-11-23', '2026-11-29'].map((d) => weekStartOf(d, [0, 6]))).toEqual(['2026-11-23', '2026-11-23']);
		expect(weekStartOf('2027-01-01', [0, 6])).toBe('2026-12-28');
	});
});
