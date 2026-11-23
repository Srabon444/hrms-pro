import { annualTax, type TaxRule } from './tax';

export type LineKind = 'earning' | 'deduction' | 'employer';
export type PayLine = {
	code: string;
	name: string;
	kind: LineKind;
	taxable: boolean;
	amount: number;
	forPeriod?: string | null;
};
export type SalaryPart = {
	code: string;
	name: string;
	kind: 'earning' | 'deduction';
	taxable: boolean;
	amount: number;
};
export type Segment = { from: string; to: string | null; parts: SalaryPart[] };
export type Item = { id: string; amount: number };
export type Settle = {
	salaryPaid: boolean;
	leave: { name: string; days: number }[];
	serviceYears: number;
	gratuityDays: number;
	gratuityMinYears: number;
	noticePayDays: number;
	noticeShortDays: number;
	asset: number;
	pfOwn: number;
	pfEmployer: number;
	pfVested: boolean;
};

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
	settle?: Settle;
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

export const failed = (error: string): PayResult => ({
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
	const settle = input.settle;
	const month = !settle?.salaryPaid;
	const employed = month ? input.days.filter((d) => d >= input.join && (input.exit === null || d <= input.exit)) : [];
	const uncovered = employed.find((d) => !segmentOn(input.segments, d));
	if (uncovered) return failed(`No approved salary covers ${uncovered}.`);
	const lastDay = settle ? (input.exit ?? '') : (employed[employed.length - 1] ?? '');
	const latest = segmentOn(input.segments, lastDay);
	if (!latest)
		return failed(settle ? `No approved salary covers ${lastDay}.` : 'Not employed on any paid day of this month.');

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
	const lateDays = month && input.latePolicyCount ? Math.floor(input.lates / input.latePolicyCount) : 0;
	const unpaidDays = inRange.reduce((sum, u) => sum + u.days, 0) + lateDays;
	const lop = Math.min(
		earned,
		Math.round(
			inRange.reduce((sum, u) => sum + (gross(segmentOn(input.segments, u.date)!) * u.days) / basis, 0) +
				(gross(latest) * lateDays) / basis
		)
	);
	if (lop) lines.push({ code: 'LOP', name: name('LOP'), kind: 'deduction', taxable: false, amount: lop });

	const overtime = month
		? Math.round(
				(basicOf(latest) * input.overtimeMinutes * input.overtimeRateBp) / (input.overtimeMonthlyHours * 60 * 10_000)
			)
		: 0;
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
	const settled = settle ? settlementLines(basicOf(latest), pf, pfEmployer, settle) : { lines: [], notes: [] };
	lines.push(...settled.lines);

	const taxable = lines.filter((l) => l.kind === 'earning' && l.taxable).reduce((sum, l) => sum + l.amount, 0) - lop;
	const t = input.tax;
	if (!t.rule) return failed('The tax year for this month is not set up.');
	const projected = t.prevIncome + t.ytdTaxable + taxable * t.remainingMonths;
	const annual = annualTax(projected, t.rebate, t.rule);
	const tax = Math.max(0, Math.round((annual - t.prevTax - t.ytdTax) / t.remainingMonths));
	if (tax) lines.push({ code: 'TAX', name: name('TAX'), kind: 'deduction', taxable: false, amount: tax });

	const total = (kind: LineKind) => lines.filter((l) => l.kind === kind).reduce((sum, l) => sum + l.amount, 0);
	let left = total('earning') - total('deduction');
	if (left < 0)
		return failed(
			settle
				? 'Deductions are more than the settlement. Lower the notice or asset deduction.'
				: 'Unpaid days, provident fund and tax are more than the pay for this month.'
		);

	const claimed = { expenses: input.expenses.map((e) => e.id), instalments: [] as string[], meals: [] as string[] };
	const skipped: string[] = [...settled.notes];
	for (const [code, items, into] of [
		['LOAN', input.instalments, claimed.instalments],
		['MEAL', input.meals, claimed.meals]
	] as const) {
		let sum = 0;
		for (const item of items) {
			if (item.amount > left) {
				skipped.push(`${name(code)} of ${money(item.amount)} does not fit in this month's pay.`);
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

const money = (poisha: number) => `৳${(poisha / 100).toFixed(2)}`;

export function settlementLines(basic: number, pf: number, pfEmployer: number, s: Settle) {
	const day = basic / 30;
	const lines: PayLine[] = [];
	const notes: string[] = [];
	const add = (code: string, name: string, kind: LineKind, taxable: boolean, amount: number) => {
		if (amount > 0) lines.push({ code, name, kind, taxable, amount });
	};
	for (const l of s.leave)
		add('LEAVE_ENCASH', `Leave encashment: ${l.name} (${l.days} days)`, 'earning', true, Math.round(day * l.days));
	add(
		'NOTICE_PAY',
		`Pay in lieu of ${s.noticePayDays} days' notice`,
		'earning',
		true,
		Math.round(day * s.noticePayDays)
	);
	if (s.serviceYears >= s.gratuityMinYears)
		add(
			'GRATUITY',
			`Gratuity for ${s.serviceYears} years of service`,
			'earning',
			false,
			Math.round(day * s.gratuityDays * s.serviceYears)
		);
	add('PF_PAYOUT', 'Provident fund payout (own)', 'earning', false, s.pfOwn + pf);
	const employer = s.pfEmployer + pfEmployer;
	if (s.pfVested) add('PF_EMPLOYER_PAYOUT', 'Provident fund payout (employer)', 'earning', false, employer);
	else if (employer > 0) notes.push(`Employer provident fund of ${money(employer)} is not vested.`);
	add(
		'NOTICE',
		`Notice shortfall of ${s.noticeShortDays} days`,
		'deduction',
		false,
		Math.round(day * s.noticeShortDays)
	);
	add('ASSET', 'Unreturned assets', 'deduction', false, s.asset);
	return { lines, notes };
}

export const serviceMonths = (join: string, on: string) =>
	(Number(on.slice(0, 4)) - Number(join.slice(0, 4))) * 12 +
	Number(on.slice(5, 7)) -
	Number(join.slice(5, 7)) -
	(on.slice(8) < join.slice(8) ? 1 : 0);

export function computeBonus(basic: number, rateBp: number, name: string): PayResult {
	const amount = Math.round((basic * rateBp) / 10_000);
	const net = roundTaka(amount);
	return {
		...failed(''),
		error: null,
		lines: amount ? [{ code: 'BONUS', name, kind: 'earning', taxable: true, amount }] : [],
		gross: amount,
		net,
		rounding: net - amount,
		taxable: amount
	};
}

const RUN_NAMES: Record<string, string> = { regular: 'Payroll', arrears: 'Salary arrears', final: 'Final settlement' };
export const runName = (r: { runType: string; title: string | null }) => r.title ?? RUN_NAMES[r.runType];
export const slipName = (r: { runType: string; title: string | null }) => (r.runType === 'regular' ? null : runName(r));

type Line = Pick<PayLine, 'code' | 'kind' | 'taxable' | 'amount'>;
const NOT_PAY = new Set(['EXPENSE', 'PF', 'TAX', 'LOAN', 'MEAL']);

export function monthPay(lines: Line[]) {
	const sum = { pay: 0, taxable: 0, pf: 0, pfEmployer: 0 };
	for (const l of lines) {
		const signed = l.kind === 'earning' ? l.amount : l.kind === 'deduction' ? -l.amount : 0;
		if (!NOT_PAY.has(l.code)) sum.pay += signed;
		if (l.kind === 'earning' && l.taxable) sum.taxable += l.amount;
		if (l.code === 'LOP' || (l.code === 'ARREARS' && l.kind === 'deduction' && l.taxable)) sum.taxable -= l.amount;
		if (l.code === 'PF') sum.pf -= signed;
		if (l.code === 'PF_EMPLOYER') sum.pfEmployer += l.amount;
	}
	return sum;
}

export function computeArrears(months: { period: string; due: Line[]; paid: Line[] }[]): PayResult {
	const lines: PayLine[] = [];
	for (const m of months) {
		const due = monthPay(m.due);
		const paid = monthPay(m.paid);
		const add = (code: string, amount: number, taxable: boolean, up: [LineKind, string], down: [LineKind, string]) => {
			const [kind, name] = amount > 0 ? up : down;
			if (amount)
				lines.push({ code, name: `${name} ${m.period}`, kind, taxable, amount: Math.abs(amount), forPeriod: m.period });
		};
		const taxed = due.taxable - paid.taxable;
		add('ARREARS', taxed, true, ['earning', 'Arrears for'], ['deduction', 'Overpaid in']);
		add(
			'ARREARS',
			due.pay - paid.pay - taxed,
			false,
			['earning', 'Untaxed arrears for'],
			['deduction', 'Untaxed overpayment in']
		);
		add('PF', due.pf - paid.pf, false, ['deduction', 'Provident fund for'], ['earning', 'Provident fund refund for']);
		add(
			'PF_EMPLOYER',
			Math.max(0, due.pfEmployer - paid.pfEmployer),
			false,
			['employer', 'Employer provident fund for'],
			['employer', '']
		);
	}
	const total = (kind: LineKind) => lines.filter((l) => l.kind === kind).reduce((sum, l) => sum + l.amount, 0);
	const exact = total('earning') - total('deduction');
	const net = roundTaka(exact);
	return {
		...failed(''),
		error: null,
		lines,
		gross: total('earning'),
		deductions: total('deduction'),
		net,
		rounding: net - exact,
		taxable: monthPay(lines).taxable
	};
}
