export const dayMonth = (mmdd: string): string => {
	const [m, d] = mmdd.split('-').map(Number);
	return new Date(Date.UTC(2000, m - 1, d)).toLocaleString('en', { day: 'numeric', month: 'long', timeZone: 'UTC' });
};

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const weekendText = (days: readonly number[]) =>
	days.length ? days.map((d) => WEEKDAYS[d]).join(', ') : 'No weekend';
