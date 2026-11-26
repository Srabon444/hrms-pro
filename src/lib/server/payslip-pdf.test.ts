import { expect, it } from 'vitest';
import { renderPayslipPdf, type PayslipPdf } from './payslip-pdf';

const slip: PayslipPdf = {
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
};

it('renders a payslip with Bengali and English text into a PDF', async () => {
	const pdf = await renderPayslipPdf(slip);
	const text = Buffer.from(pdf).toString('latin1');
	expect(text.startsWith('%PDF-')).toBe(true);
	expect(text.match(/\/Type \/Page\b/g)).toHaveLength(1);
	expect(text).toContain('NotoSansBengali');
});

it('locks the emailed copy with AES-256 and keeps the contents unreadable', async () => {
	const pdf = Buffer.from(
		await renderPayslipPdf({ ...slip, employee: 'Plainname Visible' }, 'correct horse battery')
	).toString('latin1');
	const plain = Buffer.from(await renderPayslipPdf({ ...slip, employee: 'Plainname Visible' })).toString('latin1');
	expect(pdf.startsWith('%PDF-1.7')).toBe(true);
	expect(pdf).toMatch(/\/Encrypt \d+ 0 R/);
	expect(pdf).toMatch(/\/V 5\b/);
	expect(pdf).toMatch(/\/R 5\b/);
	expect(pdf).toMatch(/\/CFM \/AESV3/);
	expect(pdf).not.toContain('Plainname');
	expect(pdf).not.toContain('Payslip 2026-10');
	expect(plain).not.toMatch(/\/Encrypt/);
	expect(plain).toContain('Payslip 2026-10');
});
