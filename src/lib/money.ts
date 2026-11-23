export const taka = (poisha: number) => (poisha / 100).toFixed(2);

export const poishaOf = (amount: string) => {
	const [whole, fraction = ''] = amount.split('.');
	return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};
