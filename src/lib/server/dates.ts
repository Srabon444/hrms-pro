export const dateIn = (at: Date, timeZone: string) =>
	new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

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
