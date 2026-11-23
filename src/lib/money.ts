export const taka = (poisha: number) => (poisha / 100).toFixed(2);

export const poishaOf = (amount: string) => {
	const [whole, fraction = ''] = amount.split('.');
	return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

export const employeeShare = (unitCost: number, subsidyPct: number) =>
	Math.round((unitCost * (100 - subsidyPct)) / 100);

export const mealCharge = (ate: boolean, guests: number, unitCost: number, subsidyPct: number) =>
	(ate ? employeeShare(unitCost, subsidyPct) : 0) + guests * unitCost;
