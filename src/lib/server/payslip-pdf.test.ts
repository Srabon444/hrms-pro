import { expect, it } from 'vitest';
import { renderPayslipPdf } from './payslip-pdf';

it('renders a payslip with Bengali and English text into a PDF', async () => {
	const pdf = await renderPayslipPdf({
		company: 'Acme Ltd',
		period: '2026-10',
		name: null,
		employee: 'আনা রহমান',
		code: 'E-001',
		paidDays: 30,
		unpaidDays: 0.5,
		gross: 5_000_000,
		deductions: 41_667,
		rounding: -33,
		net: 4_958_300,
		currency: 'BDT',
		notes: ["MEAL of 100.00 does not fit in this month's pay."],
		lines: [
			{ name: 'Basic', kind: 'earning', amount: 3_000_000 },
			{ name: 'Income tax', kind: 'deduction', amount: 41_667 },
			{ name: 'Provident fund (employer)', kind: 'employer', amount: 300_000 }
		]
	});
	const text = Buffer.from(pdf).toString('latin1');
	expect(text.startsWith('%PDF-')).toBe(true);
	expect(text.match(/\/Type \/Page\b/g)).toHaveLength(1);
	expect(text).toContain('NotoSansBengali');
});
