import { addDays, dateIn } from './dates';

export const DAY_STATUSES = ['present', 'late', 'half_day', 'absent', 'on_leave', 'holiday', 'weekend', 'wfh'] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export type ShiftRule = {
	startTime: string;
	endTime: string;
	graceMinutes: number;
	halfDayMinutes: number;
	fullDayMinutes: number;
};

export type DayInput = {
	date: string;
	shift: ShiftRule;
	timeZone: string;
	punches: Date[];
	until?: Date;
	weekend: boolean;
	holiday: boolean;
	leave: 'full' | 'am' | 'pm' | null;
	wfh: boolean;
	now: Date;
};

export type DayResult = {
	status: DayStatus;
	firstIn: Date | null;
	lastOut: Date | null;
	workedMinutes: number;
	lateMinutes: number;
};

const clockMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const dayNumber = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000;

export function localMinutes(at: Date, date: string, timeZone: string) {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat('en-CA', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		})
			.formatToParts(at)
			.map((x) => [x.type, x.value])
	);
	const local = `${p.year}-${p.month}-${p.day}`;
	return (dayNumber(local) - dayNumber(date)) * 1440 + Number(p.hour) * 60 + Number(p.minute);
}

export function shiftWindow(shift: Pick<ShiftRule, 'startTime' | 'endTime'>) {
	const start = clockMinutes(shift.startTime);
	const raw = clockMinutes(shift.endTime);
	return { start, end: raw > start ? raw : raw + 1440, from: start - 240, to: start + 1200 };
}

export function computeDay(input: DayInput): DayResult | null {
	const { start, end, from, to } = shiftWindow(input.shift);
	const marks = input.punches
		.map((at) => ({ at, m: localMinutes(at, input.date, input.timeZone) }))
		.filter((p) => p.m >= from && (input.until ? p.at < input.until : p.m < to))
		.sort((a, b) => a.m - b.m);
	const first = marks[0];
	const last = marks.length > 1 ? marks[marks.length - 1] : undefined;
	const workedMinutes = first && last ? last.m - first.m : 0;
	const base = { firstIn: first?.at ?? null, lastOut: last?.at ?? null, workedMinutes, lateMinutes: 0 };
	if (input.holiday) return { ...base, status: 'holiday' };
	if (input.weekend) return { ...base, status: 'weekend' };
	if (input.leave === 'full') return { ...base, status: 'on_leave' };
	if (input.wfh) return { ...base, status: 'wfh' };
	const ended = localMinutes(input.now, input.date, input.timeZone) >= end;
	const late = first && input.leave !== 'am' ? Math.max(0, first.m - start) : 0;
	const lateMinutes = late > input.shift.graceMinutes ? late : 0;
	if (!first) return ended ? { ...base, status: input.leave ? 'half_day' : 'absent' } : null;
	const onTime = lateMinutes ? 'late' : 'present';
	if (!ended) return { ...base, lateMinutes, status: onTime };
	const need = input.leave ? input.shift.halfDayMinutes : input.shift.fullDayMinutes;
	if (workedMinutes >= need) return { ...base, lateMinutes, status: onTime };
	if (workedMinutes >= input.shift.halfDayMinutes) return { ...base, lateMinutes, status: 'half_day' };
	return { ...base, lateMinutes, status: input.leave ? 'half_day' : 'absent' };
}

export function shiftDayOf(at: Date, shift: Pick<ShiftRule, 'startTime' | 'endTime'>, timeZone: string) {
	const { from, to } = shiftWindow(shift);
	const local = dateIn(at, timeZone);
	const m = localMinutes(at, local, timeZone);
	return addDays(local, m < from ? -1 : m >= to ? 1 : 0);
}

export function zonedInstant(local: string, timeZone: string) {
	const guess = new Date(`${local.slice(0, 16)}:00Z`);
	const wall = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
	return new Date(guess.getTime() - (localMinutes(guess, local.slice(0, 10), timeZone) - wall) * 60_000);
}
