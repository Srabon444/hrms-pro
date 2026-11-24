import { describe, expect, it } from 'vitest';
import { computeDay, localMinutes, shiftDayOf, zonedInstant, type DayInput } from './attendance-day';

const tz = 'Asia/Dhaka';
const at = (local: string) => new Date(`${local}+06:00`);
const general = {
	startTime: '09:00:00',
	endTime: '18:00:00',
	graceMinutes: 15,
	halfDayMinutes: 240,
	fullDayMinutes: 480
};
const night = { startTime: '22:00', endTime: '06:00', graceMinutes: 10, halfDayMinutes: 240, fullDayMinutes: 420 };
const day = (extra: Partial<DayInput> = {}) =>
	computeDay({
		date: '2026-03-10',
		shift: general,
		timeZone: tz,
		punches: [],
		weekend: false,
		holiday: false,
		leave: null,
		wfh: false,
		now: at('2026-03-11T12:00:00'),
		...extra
	});
const punched = (...times: string[]) => ({ punches: times.map((t) => at(`2026-03-10T${t}:00`)) });

describe('attendance day', () => {
	it('reads minutes from local midnight of the shift day, across days', () => {
		expect(localMinutes(at('2026-03-10T09:30:00'), '2026-03-10', tz)).toBe(570);
		expect(localMinutes(at('2026-03-11T05:00:00'), '2026-03-10', tz)).toBe(1740);
		expect(localMinutes(at('2026-03-09T23:00:00'), '2026-03-10', tz)).toBe(-60);
		expect(localMinutes(new Date('2026-03-10T03:30:00Z'), '2026-03-10', tz)).toBe(570);
		expect(localMinutes(new Date('2026-03-10T03:30:00Z'), '2026-03-10', 'UTC')).toBe(210);
	});

	it('puts a punch on the day its shift started', () => {
		expect(shiftDayOf(at('2026-03-10T08:55:00'), general, tz)).toBe('2026-03-10');
		expect(shiftDayOf(at('2026-03-10T23:30:00'), general, tz)).toBe('2026-03-10');
		expect(shiftDayOf(at('2026-03-11T04:59:00'), general, tz)).toBe('2026-03-10');
		expect(shiftDayOf(at('2026-03-11T05:00:00'), general, tz)).toBe('2026-03-11');
		expect(shiftDayOf(at('2026-03-10T21:55:00'), night, tz)).toBe('2026-03-10');
		expect(shiftDayOf(at('2026-03-11T06:10:00'), night, tz)).toBe('2026-03-10');
		expect(shiftDayOf(at('2026-03-11T17:59:00'), night, tz)).toBe('2026-03-10');
		expect(shiftDayOf(at('2026-03-11T18:00:00'), night, tz)).toBe('2026-03-11');
		const early = { startTime: '02:00', endTime: '10:00' };
		expect(shiftDayOf(at('2026-03-10T21:59:00'), early, tz)).toBe('2026-03-10');
		expect(shiftDayOf(at('2026-03-10T22:00:00'), early, tz)).toBe('2026-03-11');
	});

	it('marks a full day present, a late arrival late and a short day half or absent', () => {
		expect(day(punched('09:10', '18:05'))).toEqual({
			status: 'present',
			firstIn: at('2026-03-10T09:10:00'),
			lastOut: at('2026-03-10T18:05:00'),
			workedMinutes: 535,
			lateMinutes: 0
		});
		expect(day(punched('09:15', '18:00'))).toMatchObject({ status: 'present', lateMinutes: 0 });
		expect(day(punched('09:16', '18:00'))).toMatchObject({ status: 'late', lateMinutes: 16 });
		expect(day(punched('10:00', '18:00'))).toMatchObject({ status: 'late', lateMinutes: 60, workedMinutes: 480 });
		expect(day(punched('10:00', '17:59'))).toMatchObject({ status: 'half_day', workedMinutes: 479 });
		expect(day(punched('09:00', '13:00'))).toMatchObject({ status: 'half_day', workedMinutes: 240 });
		expect(day(punched('09:00', '12:59'))).toMatchObject({ status: 'absent', workedMinutes: 239 });
		expect(day(punched('09:00'))).toMatchObject({ status: 'absent', workedMinutes: 0, lastOut: null });
		expect(day(punched('13:00', '09:00', '11:00', '18:30'))).toMatchObject({
			status: 'present',
			firstIn: at('2026-03-10T09:00:00'),
			lastOut: at('2026-03-10T18:30:00'),
			workedMinutes: 570
		});
		expect(day()).toMatchObject({ status: 'absent', firstIn: null, workedMinutes: 0 });
	});

	it('ignores punches outside the shift window', () => {
		expect(day({ punches: [at('2026-03-10T04:59:00'), at('2026-03-11T05:00:00')] })).toMatchObject({
			status: 'absent',
			firstIn: null
		});
		expect(day({ punches: [at('2026-03-10T05:00:00'), at('2026-03-11T04:59:00')] })).toMatchObject({
			status: 'present',
			workedMinutes: 1439
		});
	});

	it('handles an overnight shift as one day', () => {
		const n = (punches: string[], now = '2026-03-11T12:00:00') =>
			day({ shift: night, punches: punches.map((p) => at(p)), now: at(now) });
		expect(n(['2026-03-10T22:05:00', '2026-03-11T06:00:00'])).toMatchObject({ status: 'present', workedMinutes: 475 });
		expect(n(['2026-03-10T22:11:00', '2026-03-11T06:00:00'])).toMatchObject({ status: 'late', lateMinutes: 11 });
		expect(n(['2026-03-10T23:00:00', '2026-03-11T03:30:00'])).toMatchObject({ status: 'half_day', lateMinutes: 60 });
		expect(n(['2026-03-10T22:00:00'], '2026-03-11T05:59:00')).toMatchObject({ status: 'present' });
		expect(n([], '2026-03-11T05:59:00')).toBeNull();
		expect(n([], '2026-03-11T06:00:00')).toMatchObject({ status: 'absent' });
	});

	it('shows a provisional status until the shift ends', () => {
		expect(day({ ...punched('09:20'), now: at('2026-03-10T11:00:00') })).toMatchObject({
			status: 'late',
			lateMinutes: 20
		});
		expect(day({ ...punched('08:50'), now: at('2026-03-10T17:59:00') })).toMatchObject({ status: 'present' });
		expect(day({ now: at('2026-03-10T17:59:00') })).toBeNull();
		expect(day({ now: at('2026-03-10T18:00:00') })).toMatchObject({ status: 'absent' });
		expect(day({ ...punched('08:50'), now: at('2026-03-10T18:00:00') })).toMatchObject({ status: 'absent' });
	});

	it('lets holidays, weekends, full leave and work from home win, keeping worked time', () => {
		expect(day({ ...punched('10:00', '14:00'), holiday: true, weekend: true, leave: 'full' })).toMatchObject({
			status: 'holiday',
			workedMinutes: 240,
			lateMinutes: 0
		});
		expect(day({ weekend: true, leave: 'full', wfh: true })).toMatchObject({ status: 'weekend' });
		expect(day({ leave: 'full', wfh: true })).toMatchObject({ status: 'on_leave' });
		expect(day({ wfh: true, now: at('2026-03-10T10:00:00') })).toMatchObject({ status: 'wfh' });
	});

	it('needs only half a day around a half-day leave', () => {
		expect(day({ ...punched('13:30', '17:30'), leave: 'am' })).toMatchObject({ status: 'present', lateMinutes: 0 });
		expect(day({ ...punched('13:30', '17:00'), leave: 'am' })).toMatchObject({ status: 'half_day' });
		expect(day({ ...punched('09:30', '13:30'), leave: 'pm' })).toMatchObject({ status: 'late', lateMinutes: 30 });
		expect(day({ ...punched('09:00', '12:00'), leave: 'pm' })).toMatchObject({ status: 'half_day' });
		expect(day({ leave: 'pm' })).toMatchObject({ status: 'half_day' });
		expect(day({ leave: 'am', now: at('2026-03-10T12:00:00') })).toBeNull();
	});

	it('turns a wall-clock time in the tenant zone into an instant', () => {
		expect(zonedInstant('2026-03-10T09:00', tz).toISOString()).toBe('2026-03-10T03:00:00.000Z');
		expect(zonedInstant('2026-03-10T02:30', tz).toISOString()).toBe('2026-03-09T20:30:00.000Z');
		expect(zonedInstant('2026-03-10T23:45:00', 'UTC').toISOString()).toBe('2026-03-10T23:45:00.000Z');
		expect(zonedInstant('2026-03-10T23:45', 'America/Los_Angeles').toISOString()).toBe('2026-03-11T06:45:00.000Z');
	});
});
