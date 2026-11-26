const formats = new Map<string, Intl.DateTimeFormat>();

export function zoneFormat(timeZone: string, options: Intl.DateTimeFormatOptions, locale = 'en-CA') {
	const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
	let f = formats.get(key);
	if (!f) formats.set(key, (f = new Intl.DateTimeFormat(locale, { ...options, timeZone })));
	return f;
}

export const dateIn = (at: Date, timeZone: string) =>
	zoneFormat(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

const offsetMs = (at: number, timeZone: string) => {
	const p = Object.fromEntries(
		zoneFormat(
			timeZone,
			{
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
				hourCycle: 'h23'
			},
			'en-US'
		)
			.formatToParts(new Date(at))
			.map((x) => [x.type, x.value])
	);
	return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at;
};

export function zonedUtc(date: string, time: string, timeZone: string): Date {
	const wall = Date.parse(`${date}T${time.slice(0, 5)}:00Z`);
	const first = wall - offsetMs(wall, timeZone);
	const shifted = offsetMs(first, timeZone);
	if (first + shifted === wall) return new Date(first);
	const second = wall - shifted;
	if (second + offsetMs(second, timeZone) === wall) return new Date(second);
	return new Date(Math.max(first, second));
}

export const addDays = (isoDate: string, days: number) => {
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};

export const addMonths = (period: string, months: number) => {
	const [y, m] = period.split('-').map(Number);
	const i = y * 12 + m - 1 + months;
	return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};
