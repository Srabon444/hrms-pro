import { addDays } from './dates';

export type Session = 'full' | 'am' | 'pm';
export type Calendar = { weekendDays: readonly number[]; holidays: ReadonlySet<string> };
export type LeaveDay = { date: string; session: Session };

const weekday = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

export const isWorkingDay = (isoDate: string, cal: Calendar) =>
	!cal.weekendDays.includes(weekday(isoDate)) && !cal.holidays.has(isoDate);

export function fiscalYearOf(isoDate: string, startMonth: number) {
	const year = Number(isoDate.slice(0, 4));
	return Number(isoDate.slice(5, 7)) >= startMonth ? year : year - 1;
}

export function fiscalYearRange(fy: number, startMonth: number) {
	const mm = String(startMonth).padStart(2, '0');
	return { start: `${fy}-${mm}-01`, end: addDays(`${fy + 1}-${mm}-01`, -1) };
}

export function leaveDays(start: string, end: string, session: Session, cal: Calendar, sandwich: boolean): LeaveDay[] {
	if (session !== 'full') return start === end && isWorkingDay(start, cal) ? [{ date: start, session }] : [];
	const all: string[] = [];
	for (let d = start; d <= end; d = addDays(d, 1)) all.push(d);
	if (!sandwich) return all.filter((d) => isWorkingDay(d, cal)).map((date) => ({ date, session }));
	const first = all.findIndex((d) => isWorkingDay(d, cal));
	if (first < 0) return [];
	const last = all.findLastIndex((d) => isWorkingDay(d, cal));
	return all.slice(first, last + 1).map((date) => ({ date, session }));
}

export const dayValue = (d: { session: Session }) => (d.session === 'full' ? 1 : 0.5);

const monthIndex = (isoDate: string) => Number(isoDate.slice(0, 4)) * 12 + Number(isoDate.slice(5, 7)) - 1;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function proRataQuota(quota: number, fyStart: string, joinDate: string) {
	if (joinDate <= fyStart) return quota;
	const months = 12 - (monthIndex(joinDate) - monthIndex(fyStart));
	return Math.max(0, Math.round(((quota * months) / 12) * 2) / 2);
}

export function monthlyCredits(quota: number, fyStart: string, joinDate: string, today: string) {
	const first = Math.max(monthIndex(fyStart), monthIndex(joinDate));
	const last = Math.min(monthIndex(fyStart) + 11, monthIndex(today));
	const credits: { period: string; days: number }[] = [];
	for (let m = first; m <= last; m++) {
		const k = m - monthIndex(fyStart) + 1;
		const period = `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
		credits.push({ period, days: round2(round2((quota * k) / 12) - round2((quota * (k - 1)) / 12)) });
	}
	return credits;
}
