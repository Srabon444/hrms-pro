import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { taka } from '../money';

export type BillPdf = {
	company: string;
	period: string;
	employee: string;
	code: string;
	billingMode: string;
	total: number;
	paid: number;
	lines: { date: string; meal: string; kind: string; plates: number; guests: number; amount: number }[];
};

const fontFile = (subset: string) =>
	createRequire(import.meta.url).resolve(
		`@fontsource/noto-sans-bengali/files/noto-sans-bengali-${subset}-400-normal.woff`
	);

const BENGALI = /([ঀ-৿‌‍]+)/;

function write(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width?: number, align = 'left') {
	const runs = text.split(BENGALI).filter(Boolean);
	runs.forEach((run, i) => {
		doc.font(BENGALI.test(run) ? 'bn' : 'latin');
		const opts = { continued: i < runs.length - 1, width, align: align as 'left' };
		if (i === 0) doc.text(run, x, y, opts);
		else doc.text(run, opts);
	});
}

export function renderBillPdf(bill: BillPdf): Promise<Uint8Array> {
	const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Meal bill ${bill.period}` } });
	doc.registerFont('latin', fontFile('latin'));
	doc.registerFont('bn', fontFile('bengali'));
	const chunks: Buffer[] = [];
	doc.on('data', (c: Buffer) => chunks.push(c));
	const done = new Promise<Uint8Array>((resolve) =>
		doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
	);

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
			`৳${taka(l.amount)}`
		]);
	y += 6;
	doc.fontSize(12);
	row(['', '', 'Total', `৳${taka(bill.total)}`]);
	if (bill.paid) {
		row(['', '', 'Paid', `৳${taka(bill.paid)}`]);
		row(['', '', 'Due', `৳${taka(bill.total - bill.paid)}`]);
	}
	doc.end();
	return done;
}
