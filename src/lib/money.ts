export const taka = (poisha: number) => (poisha / 100).toFixed(2);

export const CURRENCIES = {
	BDT: '৳',
	USD: '$',
	EUR: '€',
	GBP: '£',
	INR: '',
	PKR: '',
	AED: '',
	SAR: '',
	SGD: '',
	MYR: '',
	CAD: '',
	AUD: '',
	LKR: '',
	NPR: ''
} as const;

export type Currency = keyof typeof CURRENCIES;

export const unit = (code: string) => CURRENCIES[code as Currency] || code;

export const money = (poisha: number, code: string) => `${CURRENCIES[code as Currency] || `${code} `}${taka(poisha)}`;

export const poishaOf = (amount: string) => {
	const [whole, fraction = ''] = amount.split('.');
	return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

export const employeeShare = (unitCost: number, subsidyPct: number) =>
	Math.round((unitCost * (100 - subsidyPct)) / 100);

export const mealCharge = (ate: boolean, guests: number, unitCost: number, subsidyPct: number) =>
	(ate ? employeeShare(unitCost, subsidyPct) : 0) + guests * unitCost;

export const instalmentPlan = (amount: number, count: number) => {
	const each = Math.floor(amount / count / 100) * 100;
	return Array.from({ length: count }, (_, i) => (i === count - 1 ? amount - each * (count - 1) : each));
};
