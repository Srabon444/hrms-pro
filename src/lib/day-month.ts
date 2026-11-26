export const dayMonth = (mmdd: string): string => {
	const [m, d] = mmdd.split('-').map(Number);
	return new Date(Date.UTC(2000, m - 1, d)).toLocaleString('en', { day: 'numeric', month: 'long', timeZone: 'UTC' });
};
