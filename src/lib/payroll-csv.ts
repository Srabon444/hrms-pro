import { taka } from './money';

export const PAYROLL_EXPORTS = ['register', 'bank', 'pf', 'tax'] as const;
export type PayrollExport = (typeof PAYROLL_EXPORTS)[number];

type Slip = {
	paidDays: number;
	unpaidDays: number;
	gross: number;
	deductions: number;
	net: number;
	taxable: number;
	tax: number;
	lines: { code: string; kind: string; amount: number }[];
};
export type CsvPerson = {
	code: string;
	name: string;
	bankName: string | null;
	bankAccountName: string | null;
	bankAccountNumber: string | null;
	taxId: string | null;
};
type Row = (string | number | null)[];

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const lineSum = (s: Slip, code: string, kind: string) =>
	sum(s.lines.filter((l) => l.code === code && l.kind === kind).map((l) => l.amount));
const pfOf = (s: Slip) => lineSum(s, 'PF', 'deduction') - lineSum(s, 'PF', 'earning');

function register(people: CsvPerson[], slips: Slip[]): Row[] {
	const codes = (kind: string) => [
		...new Set(slips.flatMap((s) => s.lines.filter((l) => l.kind === kind).map((l) => l.code)))
	];
	const earnings = codes('earning');
	const deductions = codes('deduction');
	const employer = codes('employer');
	const row = (s: Slip) => [
		...earnings.map((c) => taka(lineSum(s, c, 'earning'))),
		taka(s.gross),
		...deductions.map((c) => taka(lineSum(s, c, 'deduction'))),
		taka(s.deductions),
		taka(s.net),
		...employer.map((c) => taka(lineSum(s, c, 'employer')))
	];
	const total: Slip = {
		...slips[0],
		lines: slips.flatMap((s) => s.lines),
		gross: sum(slips.map((s) => s.gross)),
		deductions: sum(slips.map((s) => s.deductions)),
		net: sum(slips.map((s) => s.net))
	};
	return [
		['Code', 'Name', 'Paid days', 'Unpaid days', ...earnings, 'Gross', ...deductions, 'Deductions', 'Net', ...employer],
		...people.map((p, i) => [p.code, p.name, slips[i].paidDays, slips[i].unpaidDays, ...row(slips[i])]),
		...(slips.length ? [['Total', '', '', '', ...row(total)]] : [])
	];
}

function bank(people: CsvPerson[], slips: Slip[]): Row[] {
	const paid = people.map((p, i) => ({ p, net: slips[i].net })).filter((r) => r.net > 0);
	return [
		['Code', 'Name', 'Bank', 'Account name', 'Account number', 'Amount'],
		...paid.map(({ p, net }) => [p.code, p.name, p.bankName, p.bankAccountName, p.bankAccountNumber, taka(net)]),
		['Total', '', '', '', '', taka(sum(paid.map((r) => r.net)))]
	];
}

function pf(people: CsvPerson[], slips: Slip[]): Row[] {
	const rows = people
		.map((p, i) => ({ p, own: pfOf(slips[i]), employer: lineSum(slips[i], 'PF_EMPLOYER', 'employer') }))
		.filter((r) => r.own || r.employer);
	const line = (code: string, name: string, own: number, employer: number) => [
		code,
		name,
		taka(own),
		taka(employer),
		taka(own + employer)
	];
	return [
		['Code', 'Name', 'Employee share', 'Employer share', 'Total'],
		...rows.map((r) => line(r.p.code, r.p.name, r.own, r.employer)),
		line('Total', '', sum(rows.map((r) => r.own)), sum(rows.map((r) => r.employer)))
	];
}

function tax(people: CsvPerson[], slips: Slip[], showTin: boolean): Row[] {
	const rows = people.map((p, i) => ({ p, s: slips[i] })).filter((r) => r.s.taxable > 0 || r.s.tax > 0);
	const tin = (p: CsvPerson) => (showTin ? [p.taxId] : []);
	return [
		['Code', 'Name', ...(showTin ? ['TIN'] : []), 'Taxable income', 'Tax deducted'],
		...rows.map(({ p, s }) => [p.code, p.name, ...tin(p), taka(s.taxable), taka(s.tax)]),
		[
			'Total',
			'',
			...(showTin ? [''] : []),
			taka(sum(rows.map((r) => r.s.taxable))),
			taka(sum(rows.map((r) => r.s.tax)))
		]
	];
}

export function payrollCsv(kind: PayrollExport, people: CsvPerson[], slips: Slip[], showTin: boolean): Row[] {
	if (kind === 'register') return register(people, slips);
	if (kind === 'bank') return bank(people, slips);
	if (kind === 'pf') return pf(people, slips);
	return tax(people, slips, showTin);
}
