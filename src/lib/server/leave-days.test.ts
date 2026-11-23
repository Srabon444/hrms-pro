import { describe, expect, it } from 'vitest';
import {
	dayValue,
	fiscalYearOf,
	fiscalYearRange,
	isWorkingDay,
	leaveDays,
	monthlyCredits,
	proRataQuota,
	type Calendar
} from './leave-days';

const cal: Calendar = { weekendDays: [5, 6], holidays: new Set(['2026-12-16']) };
const dates = (days: { date: string }[]) => days.map((d) => d.date);

describe('working days', () => {
	it('skips the weekend and holidays', () => {
		expect(isWorkingDay('2026-12-10', cal)).toBe(true);
		expect(isWorkingDay('2026-12-11', cal)).toBe(false);
		expect(isWorkingDay('2026-12-12', cal)).toBe(false);
		expect(isWorkingDay('2026-12-13', cal)).toBe(true);
		expect(isWorkingDay('2026-12-16', cal)).toBe(false);
		expect(isWorkingDay('2026-12-13', { weekendDays: [0], holidays: new Set() })).toBe(false);
	});
});

describe('fiscal years', () => {
	it('starts in the configured month', () => {
		expect(fiscalYearOf('2026-06-30', 7)).toBe(2025);
		expect(fiscalYearOf('2026-07-01', 7)).toBe(2026);
		expect(fiscalYearOf('2026-01-01', 1)).toBe(2026);
		expect(fiscalYearOf('2026-12-31', 1)).toBe(2026);
		expect(fiscalYearRange(2026, 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
		expect(fiscalYearRange(2026, 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
		expect(fiscalYearRange(2027, 3)).toEqual({ start: '2027-03-01', end: '2028-02-29' });
	});
});

describe('leave days', () => {
	it('counts working days only without the sandwich rule', () => {
		expect(dates(leaveDays('2026-12-10', '2026-12-14', 'full', cal, false))).toEqual([
			'2026-12-10',
			'2026-12-13',
			'2026-12-14'
		]);
		expect(dates(leaveDays('2026-12-11', '2026-12-12', 'full', cal, false))).toEqual([]);
	});

	it('counts the weekend between two leave days under the sandwich rule, not at the edges', () => {
		expect(dates(leaveDays('2026-12-10', '2026-12-13', 'full', cal, true))).toEqual([
			'2026-12-10',
			'2026-12-11',
			'2026-12-12',
			'2026-12-13'
		]);
		expect(dates(leaveDays('2026-12-11', '2026-12-14', 'full', cal, true))).toEqual(['2026-12-13', '2026-12-14']);
		expect(dates(leaveDays('2026-12-09', '2026-12-12', 'full', cal, true))).toEqual(['2026-12-09', '2026-12-10']);
		expect(leaveDays('2026-12-11', '2026-12-12', 'full', cal, true)).toEqual([]);
	});

	it('allows a half day on a single working day only', () => {
		expect(leaveDays('2026-12-10', '2026-12-10', 'am', cal, false)).toEqual([{ date: '2026-12-10', session: 'am' }]);
		expect(leaveDays('2026-12-10', '2026-12-13', 'pm', cal, false)).toEqual([]);
		expect(leaveDays('2026-12-11', '2026-12-11', 'pm', cal, false)).toEqual([]);
		expect(dayValue({ session: 'am' })).toBe(0.5);
		expect(dayValue({ session: 'full' })).toBe(1);
	});
});

describe('entitlement', () => {
	it('pro-rates a yearly quota by the months left, to the half day', () => {
		expect(proRataQuota(10, '2026-07-01', '2020-01-01')).toBe(10);
		expect(proRataQuota(10, '2026-07-01', '2026-07-01')).toBe(10);
		expect(proRataQuota(10, '2026-07-01', '2026-10-15')).toBe(7.5);
		expect(proRataQuota(14, '2026-07-01', '2027-06-30')).toBe(1);
		expect(proRataQuota(10, '2026-07-01', '2027-08-01')).toBe(0);
	});

	it('credits monthly accrual from the later of the fiscal start and the join month, summing to the quota', () => {
		const year = monthlyCredits(14, '2026-07-01', '2020-01-01', '2027-09-01');
		expect(year).toHaveLength(12);
		expect(year[0]).toEqual({ period: '2026-07', days: 1.17 });
		expect(year[11].period).toBe('2027-06');
		expect(year.reduce((s, c) => Math.round((s + c.days) * 100) / 100, 0)).toBe(14);
		expect(monthlyCredits(18, '2026-07-01', '2026-09-20', '2026-11-02')).toEqual([
			{ period: '2026-09', days: 1.5 },
			{ period: '2026-10', days: 1.5 },
			{ period: '2026-11', days: 1.5 }
		]);
		expect(monthlyCredits(18, '2026-07-01', '2026-12-01', '2026-11-02')).toEqual([]);
	});
});
