import { describe, expect, it } from 'vitest';
import { computePay, roundTaka, type PayInput, type Segment } from './payroll';

const days = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
const part = (code: string, amount: number) => ({ code, name: code, kind: 'earning' as const, taxable: true, amount });
const salary: Segment = {
	from: '2026-01-01',
	to: null,
	parts: [part('BASIC', 3_000_000), part('HOUSE_RENT', 1_500_000), part('MEDICAL', 500_000)]
};
const rule = {
	bands: [
		{ width: 35_000_000, rateBp: 0 },
		{ width: null, rateBp: 1000 }
	],
	exemptionCap: 45_000_000,
	exemptionDivisor: 3,
	minimumTax: 500_000
};
const base: PayInput = {
	days,
	join: '2020-01-01',
	exit: null,
	segments: [salary],
	unpaid: [],
	lates: 0,
	latePolicyCount: 3,
	overtimeMinutes: 0,
	overtimeRateBp: 20_000,
	overtimeMonthlyHours: 208,
	pfEmployeeRateBp: 0,
	pfEmployerRateBp: 0,
	expenses: [],
	instalments: [],
	meals: [],
	tax: { rule, rebate: 0, prevIncome: 0, prevTax: 0, ytdTaxable: 0, ytdTax: 0, remainingMonths: 12 },
	names: { TAX: 'Income tax' }
};
const amounts = (r: ReturnType<typeof computePay>) => Object.fromEntries(r.lines.map((l) => [l.code, l.amount]));

describe('computePay', () => {
	it('pays a full month and withholds a twelfth of the projected tax, rounding net to the taka', () => {
		const r = computePay(base);
		expect(amounts(r)).toEqual({ BASIC: 3_000_000, HOUSE_RENT: 1_500_000, MEDICAL: 500_000, TAX: 41_667 });
		expect(r.lines.find((l) => l.code === 'TAX')!.name).toBe('Income tax');
		expect([r.gross, r.deductions, r.net, r.rounding, r.taxable, r.tax]).toEqual([
			5_000_000, 41_667, 4_958_300, -33, 5_000_000, 41_667
		]);
		expect([r.paidDays, r.unpaidDays, r.error]).toEqual([30, 0, null]);
	});

	it('prorates a joiner, charges unpaid and late days, pays overtime and expenses, and fits deductions', () => {
		const r = computePay({
			...base,
			join: '2026-11-16',
			unpaid: [
				{ date: '2026-11-10', days: 1 },
				{ date: '2026-11-20', days: 1 },
				{ date: '2026-11-21', days: 0.5 }
			],
			lates: 7,
			overtimeMinutes: 120,
			pfEmployeeRateBp: 1000,
			pfEmployerRateBp: 1200,
			expenses: [{ id: 'e1', amount: 250_000 }],
			instalments: [{ id: 'i1', amount: 200_000 }],
			meals: [{ id: 'm1', amount: 10_000_000 }],
			tax: { ...base.tax, remainingMonths: 8 }
		});
		expect(amounts(r)).toEqual({
			BASIC: 1_500_000,
			HOUSE_RENT: 750_000,
			MEDICAL: 250_000,
			LOP: 583_333,
			OVERTIME: 57_692,
			EXPENSE: 250_000,
			PF: 150_000,
			PF_EMPLOYER: 180_000,
			LOAN: 200_000
		});
		expect([r.paidDays, r.unpaidDays, r.taxable, r.tax]).toEqual([15, 3.5, 1_974_359, 0]);
		expect([r.gross, r.deductions, r.net, r.rounding]).toEqual([2_807_692, 933_333, 1_874_400, 41]);
		expect(r.claimed).toEqual({ expenses: ['e1'], instalments: ['i1'], meals: [] });
		expect(r.skipped).toEqual(["MEAL of ৳100000.00 does not fit in this month's pay."]);
	});

	it('splits a month across two salaries', () => {
		const r = computePay({
			...base,
			segments: [
				{ from: '2026-01-01', to: '2026-11-15', parts: [part('BASIC', 3_000_000)] },
				{ from: '2026-11-16', to: null, parts: [part('BASIC', 6_000_000)] }
			]
		});
		expect(amounts(r).BASIC).toBe(4_500_000);
	});

	it('leaves out components of a salary that starts after the person left', () => {
		const r = computePay({
			...base,
			exit: '2026-11-20',
			segments: [
				{ from: '2026-01-01', to: '2026-11-25', parts: [part('BASIC', 3_000_000)] },
				{ from: '2026-11-26', to: null, parts: [part('BASIC', 3_000_000), part('BONUS', 100_000)] }
			]
		});
		expect(Object.keys(amounts(r))).toEqual(['BASIC']);
		expect(amounts(r).BASIC).toBe(2_000_000);
	});

	it('takes loans and meals in order while they fit in the pay', () => {
		const r = computePay({
			...base,
			instalments: [
				{ id: 'i1', amount: 4_000_000 },
				{ id: 'i2', amount: 958_333 },
				{ id: 'i3', amount: 1 }
			],
			meals: [{ id: 'm1', amount: 1 }]
		});
		expect(r.claimed).toEqual({ expenses: [], instalments: ['i1', 'i2'], meals: [] });
		expect([amounts(r).LOAN, r.net]).toEqual([4_958_333, 0]);
		expect(r.skipped).toEqual([
			"LOAN of ৳0.01 does not fit in this month's pay.",
			"MEAL of ৳0.01 does not fit in this month's pay."
		]);
	});

	it('nets earlier tax paid this year against the projection', () => {
		const last = { ...base.tax, remainingMonths: 1, ytdTaxable: 55_000_000 };
		expect(computePay({ ...base, tax: { ...last, ytdTax: 400_000 } }).tax).toBe(100_000);
		expect(computePay({ ...base, tax: { ...last, prevTax: 600_000 } }).tax).toBe(0);
		expect(computePay({ ...base, tax: { ...last, prevIncome: 10_000_000 } }).tax).toBe(1_166_667);
		expect(computePay({ ...base, tax: { ...base.tax, rebate: 100_000 } }).tax).toBe(41_667);
	});

	it('caps unpaid days at the pay and refuses a month whose deductions exceed it', () => {
		const lates = { ...base, lates: 100, latePolicyCount: 1, tax: { ...base.tax, rule: { ...rule, minimumTax: 0 } } };
		const r = computePay(lates);
		expect([amounts(r).LOP, r.net, r.unpaidDays]).toEqual([5_000_000, 0, 100]);
		expect(computePay({ ...lates, pfEmployeeRateBp: 1000 }).error).toBe(
			'Unpaid days, provident fund and tax are more than the pay for this month.'
		);
		expect(computePay({ ...base, lates: 100, latePolicyCount: 0 }).unpaidDays).toBe(0);
	});

	it('reports why a payslip cannot be computed', () => {
		expect(computePay({ ...base, segments: [{ ...salary, from: '2026-11-10' }] }).error).toBe(
			'No approved salary covers 2026-11-01.'
		);
		expect(computePay({ ...base, exit: '2026-10-31' }).error).toBe('Not employed on any paid day of this month.');
		expect(computePay({ ...base, tax: { ...base.tax, rule: null } }).error).toBe(
			'The tax year for this month is not set up.'
		);
	});

	it('rounds to the nearest taka', () => {
		expect([roundTaka(149), roundTaka(150), roundTaka(-149)]).toEqual([100, 200, -100]);
	});
});
