import { describe, expect, it } from 'vitest';
import {
	computeArrears,
	computeBonus,
	computePay,
	monthPay,
	roundTaka,
	runName,
	serviceMonths,
	settlementLines,
	slipName,
	type LineKind,
	type PayInput,
	type Segment,
	type Settle
} from './payroll';

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

describe('bonus', () => {
	it('counts whole months of service up to a date', () => {
		expect(serviceMonths('2026-01-05', '2026-11-30')).toBe(10);
		expect(serviceMonths('2026-01-31', '2026-02-28')).toBe(0);
		expect(serviceMonths('2025-11-30', '2026-11-30')).toBe(12);
		expect(serviceMonths('2026-12-01', '2026-11-30')).toBe(-1);
	});

	it('pays a percent of basic as one taxable earning rounded to the taka', () => {
		const r = computeBonus(3_000_050, 5000, 'Eid bonus');
		expect(r.lines).toEqual([{ code: 'BONUS', name: 'Eid bonus', kind: 'earning', taxable: true, amount: 1_500_025 }]);
		expect([r.gross, r.taxable, r.net, r.rounding, r.tax, r.deductions, r.error]).toEqual([
			1_500_025,
			1_500_025,
			1_500_000,
			-25,
			0,
			0,
			null
		]);
		expect(computeBonus(3_000_000, 0, 'Eid bonus')).toMatchObject({ lines: [], gross: 0, net: 0, error: null });
	});
});

describe('arrears', () => {
	const l = (code: string, kind: LineKind, amount: number, taxable = false) => ({ code, kind, amount, taxable });

	it('measures the pay, taxable pay and provident fund of a month', () => {
		expect(
			monthPay([
				l('BASIC', 'earning', 3_000_000, true),
				l('MEDICAL', 'earning', 500_000),
				l('LOP', 'deduction', 200_000),
				l('OVERTIME', 'earning', 50_000, true),
				l('EXPENSE', 'earning', 100_000),
				l('PF', 'deduction', 300_000),
				l('PF_EMPLOYER', 'employer', 300_000),
				l('TAX', 'deduction', 10_000),
				l('LOAN', 'deduction', 20_000),
				l('MEAL', 'deduction', 30_000)
			])
		).toEqual({ pay: 3_350_000, taxable: 2_850_000, pf: 300_000, pfEmployer: 300_000 });
	});

	it('pays what each month is short, takes back what it overpaid, and settles to zero once paid', () => {
		const a = {
			period: '2026-08',
			due: [
				l('BASIC', 'earning', 4_000_000, true),
				l('PF', 'deduction', 400_000),
				l('PF_EMPLOYER', 'employer', 400_000)
			],
			paid: [
				l('BASIC', 'earning', 3_000_000, true),
				l('PF', 'deduction', 300_000),
				l('PF_EMPLOYER', 'employer', 300_000)
			]
		};
		const b = {
			period: '2026-09',
			due: [l('BASIC', 'earning', 3_000_000, true), l('PF', 'deduction', 250_000), l('PF_EMPLOYER', 'employer', 1)],
			paid: [l('BASIC', 'earning', 3_000_000, true), l('MEDICAL', 'earning', 500_050), l('PF', 'deduction', 300_000)]
		};
		const r = computeArrears([a, b]);
		expect(r.lines.map((x) => [x.name, x.kind, x.taxable, x.amount, x.forPeriod])).toEqual([
			['Arrears for 2026-08', 'earning', true, 1_000_000, '2026-08'],
			['Provident fund for 2026-08', 'deduction', false, 100_000, '2026-08'],
			['Employer provident fund for 2026-08', 'employer', false, 100_000, '2026-08'],
			['Untaxed overpayment in 2026-09', 'deduction', false, 500_050, '2026-09'],
			['Provident fund refund for 2026-09', 'earning', false, 50_000, '2026-09'],
			['Employer provident fund for 2026-09', 'employer', false, 1, '2026-09']
		]);
		expect([r.gross, r.deductions, r.net, r.rounding, r.taxable, r.tax, r.error]).toEqual([
			1_050_000,
			600_050,
			450_000,
			50,
			1_000_000,
			0,
			null
		]);
		const settled = [a, b].map((m) => ({
			...m,
			paid: [...m.paid, ...r.lines.filter((x) => x.forPeriod === m.period)]
		}));
		expect(computeArrears(settled).lines).toEqual([]);
		const over = {
			period: '2026-08',
			due: [l('BASIC', 'earning', 2_000_000, true)],
			paid: [l('BASIC', 'earning', 3_000_000, true), l('PF_EMPLOYER', 'employer', 300_000)]
		};
		const back = computeArrears([over]);
		expect(back.lines).toEqual([
			{
				code: 'ARREARS',
				name: 'Overpaid in 2026-08',
				kind: 'deduction',
				taxable: true,
				amount: 1_000_000,
				forPeriod: '2026-08'
			}
		]);
		expect(computeArrears([{ ...over, paid: [...over.paid, ...back.lines] }]).lines).toEqual([]);
	});

	it('names runs by their kind or bonus title', () => {
		expect(runName({ runType: 'regular', title: null })).toBe('Payroll');
		expect(runName({ runType: 'arrears', title: null })).toBe('Salary arrears');
		expect(slipName({ runType: 'regular', title: null })).toBeNull();
		expect(slipName({ runType: 'bonus', title: 'Eid bonus' })).toBe('Eid bonus');
	});
});

describe('final settlement', () => {
	const settle: Settle = {
		salaryPaid: false,
		leave: [{ name: 'Annual leave', days: 12 }],
		serviceYears: 6,
		gratuityDays: 30,
		gratuityMinYears: 5,
		noticePayDays: 0,
		noticeShortDays: 0,
		asset: 0,
		pfOwn: 600_000,
		pfEmployer: 600_000,
		pfVested: true
	};
	const lines = (r: { lines: { code: string; name: string; kind: LineKind; taxable: boolean; amount: number }[] }) =>
		r.lines.map((l) => [l.code, l.kind, l.taxable, l.amount]);

	it('encashes leave and pays gratuity from the minimum years at a thirtieth of basic a day, and pays out both provident fund shares', () => {
		const r = settlementLines(3_000_000, 30_000, 20_000, { ...settle, serviceYears: 5 });
		expect(lines(r)).toEqual([
			['LEAVE_ENCASH', 'earning', true, 1_200_000],
			['GRATUITY', 'earning', false, 15_000_000],
			['PF_PAYOUT', 'earning', false, 630_000],
			['PF_EMPLOYER_PAYOUT', 'earning', false, 620_000]
		]);
		expect(r.lines.map((l) => l.name)).toEqual([
			'Leave encashment: Annual leave (12 days)',
			'Gratuity for 5 years of service',
			'Provident fund payout (own)',
			'Provident fund payout (employer)'
		]);
		expect(r.notes).toEqual([]);
	});

	it('skips gratuity before the minimum years, keeps unvested employer fund back, and prices notice and assets', () => {
		const paid = settlementLines(3_000_000, 0, 0, {
			...settle,
			leave: [],
			serviceYears: 4,
			noticePayDays: 10,
			pfVested: false
		});
		expect(lines(paid)).toEqual([
			['NOTICE_PAY', 'earning', true, 1_000_000],
			['PF_PAYOUT', 'earning', false, 600_000]
		]);
		expect(paid.notes).toEqual(['Employer provident fund of ৳6000.00 is not vested.']);
		const short = settlementLines(3_000_000, 0, 0, {
			...settle,
			leave: [],
			gratuityDays: 0,
			pfOwn: 0,
			pfEmployer: 0,
			noticeShortDays: 5,
			asset: 250_000
		});
		expect(lines(short)).toEqual([
			['NOTICE', 'deduction', false, 500_000],
			['ASSET', 'deduction', false, 250_000]
		]);
		expect(short.lines.map((l) => l.name)).toEqual(['Notice shortfall of 5 days', 'Unreturned assets']);
	});

	it('pays the exit month to the exit day, then settles on the full monthly basic', () => {
		const r = computePay({
			...base,
			exit: '2026-11-15',
			pfEmployeeRateBp: 1000,
			tax: { ...base.tax, remainingMonths: 1 },
			settle
		});
		expect(amounts(r)).toEqual({
			BASIC: 1_500_000,
			HOUSE_RENT: 750_000,
			MEDICAL: 250_000,
			PF: 150_000,
			LEAVE_ENCASH: 1_200_000,
			GRATUITY: 18_000_000,
			PF_PAYOUT: 750_000,
			PF_EMPLOYER_PAYOUT: 600_000
		});
		expect([r.paidDays, r.taxable, r.error]).toEqual([15, 3_700_000, null]);
	});

	it('leaves the month out when payroll already paid it', () => {
		const r = computePay({
			...base,
			exit: '2026-11-30',
			unpaid: [{ date: '2026-11-03', days: 1 }],
			lates: 9,
			overtimeMinutes: 600,
			pfEmployeeRateBp: 1000,
			tax: { ...base.tax, remainingMonths: 1 },
			settle: { ...settle, salaryPaid: true, gratuityDays: 0 }
		});
		expect(amounts(r)).toEqual({ LEAVE_ENCASH: 1_200_000, PF_PAYOUT: 600_000, PF_EMPLOYER_PAYOUT: 600_000 });
		expect([r.paidDays, r.unpaidDays, r.net]).toEqual([0, 0, 2_400_000]);
	});

	it('refuses a settlement whose deductions are more than it pays, or with no salary on the exit day', () => {
		const settled = { ...base, exit: '2026-11-30', tax: { ...base.tax, remainingMonths: 1 } };
		expect(
			computePay({
				...settled,
				settle: { ...settle, salaryPaid: true, leave: [], gratuityDays: 0, pfOwn: 0, pfEmployer: 0, asset: 100_000 }
			}).error
		).toBe('Deductions are more than the settlement. Lower the notice or asset deduction.');
		expect(
			computePay({ ...settled, segments: [{ ...salary, to: '2026-11-20' }], settle: { ...settle, salaryPaid: true } })
				.error
		).toBe('No approved salary covers 2026-11-30.');
	});
});
