import { money } from '../money';
import type { LineKind } from '../payroll';
import { pdfDoc, write } from './pdf';

export type PayslipPdf = {
	company: string;
	period: string;
	name: string | null;
	employee: string;
	code: string;
	paidDays: number;
	unpaidDays: number;
	gross: number;
	deductions: number;
	rounding: number;
	net: number;
	currency: string;
	notes: string[];
	lines: { name: string; kind: LineKind; amount: number }[];
};

const SECTIONS: [LineKind, string][] = [
	['earning', 'Earnings'],
	['deduction', 'Deductions'],
	['employer', 'Paid by the employer']
];

export function renderPayslipPdf(slip: PayslipPdf, password?: string): Promise<Uint8Array> {
	const { doc, done } = pdfDoc(`Payslip ${slip.period}`, password);
	doc.fontSize(16);
	write(doc, slip.company, 48, 48);
	doc.fontSize(12);
	write(doc, `${slip.name ?? 'Payslip'} for ${slip.period}`, 48, 74);
	write(doc, `${slip.employee} (${slip.code})`, 48, 94);
	if (!slip.name) write(doc, `Paid days ${slip.paidDays} · Unpaid days ${slip.unpaidDays}`, 48, 112);

	let y = 148;
	const row = (label: string, amount: string) => {
		write(doc, label, 48, y, 380);
		write(doc, amount, 430, y, 117, 'right');
		y += 18;
	};
	for (const [kind, title] of SECTIONS) {
		const lines = slip.lines.filter((l) => l.kind === kind);
		if (!lines.length) continue;
		doc.fontSize(12);
		row(title, '');
		doc.fontSize(10);
		for (const l of lines) row(l.name, money(l.amount, slip.currency));
		y += 8;
	}
	doc.fontSize(12);
	row('Gross pay', money(slip.gross, slip.currency));
	row('Total deductions', money(slip.deductions, slip.currency));
	if (slip.rounding) row('Rounding', money(slip.rounding, slip.currency));
	row('Net pay', money(slip.net, slip.currency));
	doc.fontSize(10);
	for (const n of slip.notes) row(n, '');
	doc.end();
	return done;
}
