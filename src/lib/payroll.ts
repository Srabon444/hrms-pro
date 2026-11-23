import { annualTax, type TaxRule } from './tax';

export type LineKind = 'earning' | 'deduction' | 'employer';
export type PayLine = { code: string; name: string; kind: LineKind; taxable: boolean; amount: number };
export type SalaryPart = {
	code: string;
	name: string;
	kind: 'earning' | 'deduction';
	taxable: boolean;
	amount: number;
};
export type Segment = { from: string; to: string | null; parts: SalaryPart[] };
export type Item = { id: string; amount: number };

export type PayInput = {
	days: string[];
	join: string;
	exit: string | null;
	segments: Segment[];
	unpaid: { date: string; days: number }[];
	lates: number;
	latePolicyCount: number;
	overtimeMinutes: number;
	overtimeRateBp: number;
	overtimeMonthlyHours: number;
	pfEmployeeRateBp: number;
	pfEmployerRateBp: number;
	expenses: Item[];
	instalments: Item[];
	meals: Item[];
	tax: {
		rule: TaxRule | null;
		rebate: number;
		prevIncome: number;
		prevTax: number;
		ytdTaxable: number;
		ytdTax: number;
		remainingMonths: number;
	};
	names: Record<string, string>;
};

export type PayResult = {
	lines: PayLine[];
	paidDays: number;
	unpaidDays: number;
	gross: number;
	deductions: number;
	rounding: number;
	net: number;
	taxable: number;
	tax: number;
	claimed: { expenses: string[]; instalments: string[]; meals: string[] };
	skipped: string[];
	error: string | null;
};

export const roundTaka = (poisha: number) => Math.round(poisha / 100) * 100;

const segmentOn = (segments: Segment[], date: string) =>
	segments.find((s) => s.from <= date && (s.to === null || s.to >= date));

const gross = (s: Segment) => s.parts.filter((p) => p.kind === 'earning').reduce((sum, p) => sum + p.amount, 0);
const basicOf = (s: Segment) => s.parts.find((p) => p.code === 'BASIC')?.amount ?? 0;

const failed = (error: string): PayResult => ({
	lines: [],
	paidDays: 0,
	unpaidDays: 0,
	gross: 0,
	deductions: 0,
	rounding: 0,
	net: 0,
	taxable: 0,
	tax: 0,
	claimed: { expenses: [], instalments: [], meals: [] },
	skipped: [],
	error
});

export function computePay(input: PayInput): PayResult {
	const basis = input.days.length;
	const employed = input.days.filter((d) => d >= input.join && (input.exit === null || d <= input.exit));
	const uncovered = employed.find((d) => !segmentOn(input.segments, d));
	if (uncovered) return failed(`No approved salary covers ${uncovered}.`);
	const latest = segmentOn(input.segments, employed[employed.length - 1] ?? '');
	if (!latest) return failed('Not employed on any paid day of this month.');

	const parts = new Map<string, SalaryPart>();
	for (const s of input.segments) {
		const share = employed.filter((d) => segmentOn([s], d)).length;
		for (const p of s.parts) {
			const prev = parts.get(p.code);
			const amount = Math.round((p.amount * share) / basis);
			parts.set(p.code, { ...p, amount: (prev?.amount ?? 0) + amount });
		}
	}
	const lines: PayLine[] = [...parts.values()].filter((p) => p.amount > 0);
	const earned = lines.filter((l) => l.kind === 'earning').reduce((sum, l) => sum + l.amount, 0);
	const name = (code: string) => input.names[code] ?? code;

	const inRange = input.unpaid.filter((u) => employed.includes(u.date));
	const lateDays = input.latePolicyCount ? Math.floor(input.lates / input.latePolicyCount) : 0;
	const unpaidDays = inRange.reduce((sum, u) => sum + u.days, 0) + lateDays;
	const lop = Math.min(
		earned,
		Math.round(
			inRange.reduce((sum, u) => sum + (gross(segmentOn(input.segments, u.date)!) * u.days) / basis, 0) +
				(gross(latest) * lateDays) / basis
		)
	);
	if (lop) lines.push({ code: 'LOP', name: name('LOP'), kind: 'deduction', taxable: false, amount: lop });

	const overtime = Math.round(
		(basicOf(latest) * input.overtimeMinutes * input.overtimeRateBp) / (input.overtimeMonthlyHours * 60 * 10_000)
	);
	if (overtime)
		lines.push({ code: 'OVERTIME', name: name('OVERTIME'), kind: 'earning', taxable: true, amount: overtime });

	const expense = input.expenses.reduce((sum, e) => sum + e.amount, 0);
	if (expense) lines.push({ code: 'EXPENSE', name: name('EXPENSE'), kind: 'earning', taxable: false, amount: expense });

	const basic = parts.get('BASIC')?.amount ?? 0;
	const pf = Math.round((basic * input.pfEmployeeRateBp) / 10_000);
	if (pf) lines.push({ code: 'PF', name: name('PF'), kind: 'deduction', taxable: false, amount: pf });
	const pfEmployer = Math.round((basic * input.pfEmployerRateBp) / 10_000);
	if (pfEmployer)
		lines.push({
			code: 'PF_EMPLOYER',
			name: name('PF_EMPLOYER'),
			kind: 'employer',
			taxable: false,
			amount: pfEmployer
		});

	const taxable = lines.filter((l) => l.kind === 'earning' && l.taxable).reduce((sum, l) => sum + l.amount, 0) - lop;
	const t = input.tax;
	if (!t.rule) return failed('The tax year for this month is not set up.');
	const projected = t.prevIncome + t.ytdTaxable + taxable * t.remainingMonths;
	const annual = annualTax(projected, t.rebate, t.rule);
	const tax = Math.max(0, Math.round((annual - t.prevTax - t.ytdTax) / t.remainingMonths));
	if (tax) lines.push({ code: 'TAX', name: name('TAX'), kind: 'deduction', taxable: false, amount: tax });

	const total = (kind: LineKind) => lines.filter((l) => l.kind === kind).reduce((sum, l) => sum + l.amount, 0);
	let left = total('earning') - total('deduction');
	if (left < 0) return failed('Unpaid days, provident fund and tax are more than the pay for this month.');

	const claimed = { expenses: input.expenses.map((e) => e.id), instalments: [] as string[], meals: [] as string[] };
	const skipped: string[] = [];
	for (const [code, items, into] of [
		['LOAN', input.instalments, claimed.instalments],
		['MEAL', input.meals, claimed.meals]
	] as const) {
		let sum = 0;
		for (const item of items) {
			if (item.amount > left) {
				skipped.push(`${name(code)} of ৳${(item.amount / 100).toFixed(2)} does not fit in this month's pay.`);
				continue;
			}
			left -= item.amount;
			sum += item.amount;
			into.push(item.id);
		}
		if (sum) lines.push({ code, name: name(code), kind: 'deduction', taxable: false, amount: sum });
	}

	const net = total('earning') - total('deduction');
	const rounded = roundTaka(net);
	return {
		lines,
		paidDays: employed.length,
		unpaidDays,
		gross: total('earning'),
		deductions: total('deduction'),
		rounding: rounded - net,
		net: rounded,
		taxable,
		tax,
		claimed,
		skipped,
		error: null
	};
}
