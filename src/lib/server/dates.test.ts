import { describe, expect, it } from 'vitest';
import { addDays, dateIn } from './dates';

describe('dates', () => {
	it('reads the calendar day in the tenant time zone', () => {
		const at = new Date('2026-01-01T19:30:00Z');
		expect(dateIn(at, 'Asia/Dhaka')).toBe('2026-01-02');
		expect(dateIn(at, 'UTC')).toBe('2026-01-01');
		expect(dateIn(at, 'America/New_York')).toBe('2026-01-01');
	});

	it('adds days across month, leap and year ends', () => {
		expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2026-03-29', 90)).toBe('2026-06-27');
	});
});
