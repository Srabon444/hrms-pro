import { describe, expect, it } from 'vitest';
import { payrollCsv, type CsvPerson } from './payroll-csv';

const person = (code: string, name: string): CsvPerson => ({
	code,
	name,
	bankName: null,
	bankAccountName: null,
	bankAccountNumber: null,
	taxId: null
});
const people = [person('E1', 'Amy'), person('E2', 'Ben')];
const slips = [
	{
		paidDays: 30,
		unpaidDays: 0,
		gross: 1_000_000,
		deductions: 100_000,
		net: 900_000,
		taxable: 1_000_000,
		tax: 0,
		lines: [
			{ code: 'BASIC', kind: 'earning', amount: 1_000_000 },
			{ code: 'PF', kind: 'deduction', amount: 100_000 },
			{ code: 'PF', kind: 'earning', amount: 30_000 },
			{ code: 'PF_EMPLOYER', kind: 'employer', amount: 50_000 }
		]
	},
	{
		paidDays: 0,
		unpaidDays: 30,
		gross: 0,
		deductions: 0,
		net: 0,
		taxable: 0,
		tax: 0,
		lines: []
	}
];

describe('payroll CSV reports', () => {
	it('nets provident fund refunds and leaves out people with nothing to report', () => {
		expect(payrollCsv('pf', people, slips, false)).toEqual([
			['Code', 'Name', 'Employee share', 'Employer share', 'Total'],
			['E1', 'Amy', '700.00', '500.00', '1200.00'],
			['Total', '', '700.00', '500.00', '1200.00']
		]);
		expect(payrollCsv('bank', people, slips, false).map((r) => r[0])).toEqual(['Code', 'E1', 'Total']);
		expect(payrollCsv('tax', people, slips, true).map((r) => r[0])).toEqual(['Code', 'E1', 'Total']);
	});

	it('lists every payslip in the register with a total row only when there are payslips', () => {
		expect(payrollCsv('register', people, slips, false)).toEqual([
			['Code', 'Name', 'Paid days', 'Unpaid days', 'BASIC', 'PF', 'Gross', 'PF', 'Deductions', 'Net', 'PF_EMPLOYER'],
			['E1', 'Amy', 30, 0, '10000.00', '300.00', '10000.00', '1000.00', '1000.00', '9000.00', '500.00'],
			['E2', 'Ben', 0, 30, '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00'],
			['Total', '', '', '', '10000.00', '300.00', '10000.00', '1000.00', '1000.00', '9000.00', '500.00']
		]);
		expect(payrollCsv('register', [], [], false)).toEqual([
			['Code', 'Name', 'Paid days', 'Unpaid days', 'Gross', 'Deductions', 'Net']
		]);
	});
});
