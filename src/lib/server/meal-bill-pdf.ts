import { money } from '../money';
import { pdfDoc, write } from './pdf';

export type BillPdf = {
	company: string;
	period: string;
	employee: string;
	code: string;
	billingMode: string;
	total: number;
	paid: number;
	currency: string;
	lines: { date: string; meal: string; kind: string; plates: number; guests: number; amount: number }[];
};

export function renderBillPdf(bill: BillPdf): Promise<Uint8Array> {
	const { doc, done } = pdfDoc(`Meal bill ${bill.period}`);

	doc.fontSize(16);
	write(doc, bill.company, 48, 48);
	doc.fontSize(12);
	write(doc, `Meal bill for ${bill.period}`, 48, 74);
	write(doc, `${bill.employee} (${bill.code})`, 48, 94);
	write(doc, bill.billingMode === 'payroll' ? 'Deducted from salary' : 'Paid directly to the meal manager', 48, 112);

	doc.fontSize(10);
	let y = 148;
	const row = (cells: string[]) => {
		write(doc, cells[0], 48, y, 90);
		write(doc, cells[1], 140, y, 170);
		write(doc, cells[2], 312, y, 140);
		write(doc, cells[3], 452, y, 95, 'right');
		y += 18;
		if (y > 770) {
			doc.addPage();
			y = 48;
		}
	};
	row(['Date', 'Meal', 'Eaten', 'Amount']);
	for (const l of bill.lines)
		row([
			l.date,
			l.kind === 'adjustment' ? `${l.meal} (correction)` : l.meal,
			`${l.plates ? 'ate' : 'skipped'}${l.guests ? ` + ${l.guests} guests` : ''}`,
			money(l.amount, bill.currency)
		]);
	y += 6;
	doc.fontSize(12);
	row(['', '', 'Total', money(bill.total, bill.currency)]);
	if (bill.paid) {
		row(['', '', 'Paid', money(bill.paid, bill.currency)]);
		row(['', '', 'Due', money(bill.total - bill.paid, bill.currency)]);
	}
	doc.end();
	return done;
}
