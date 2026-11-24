import { toCsv } from '../csv';
import { pdfDoc, write } from '../pdf';
import type { Cell, Report } from './types';

const text = (v: Cell) => (v == null ? '' : String(v));

export const reportPeriod = (r: Report) =>
	`${r.params.from} to ${r.params.to}${r.params.departmentName ? ` · ${r.params.departmentName}` : ''}`;

export const reportFileName = (r: Report, ext: string) => `${r.id}-${r.params.from}-${r.params.to}.${ext}`;

export const reportCsv = (r: Report): string =>
	toCsv([
		[r.title],
		[reportPeriod(r)],
		...r.sections.flatMap((s) => [
			[],
			[s.title],
			s.columns.map((c) => c.label),
			...s.rows.map((row) => s.columns.map((c) => row.cells[c.key] ?? null))
		])
	]);

export function reportPdf(company: string, r: Report): Promise<Uint8Array> {
	const { doc, done } = pdfDoc(r.title);
	const left = 48;
	const width = 499;
	let y = 48;
	const room = (h: number) => {
		if (y + h <= 790) return;
		doc.addPage();
		y = 48;
	};
	doc.fontSize(16);
	write(doc, company, left, y);
	y += 24;
	doc.fontSize(13);
	write(doc, r.title, left, y);
	y += 18;
	doc.fontSize(10);
	write(doc, reportPeriod(r), left, y);
	y += 24;
	for (const s of r.sections) {
		room(48);
		doc.fontSize(12);
		write(doc, s.title, left, y);
		y += 20;
		doc.fontSize(8);
		const w = width / s.columns.length;
		const line = (cells: string[]) => {
			const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: w - 4 })), 10);
			room(h + 4);
			cells.forEach((c, i) => write(doc, c, left + i * w, y, w - 4, s.columns[i].numeric ? 'right' : 'left'));
			y += h + 4;
		};
		line(s.columns.map((c) => c.label));
		if (!s.rows.length) line(['Nothing in this period.', ...s.columns.slice(1).map(() => '')]);
		for (const row of s.rows) line(s.columns.map((c) => text(row.cells[c.key] ?? null)));
		y += 12;
	}
	doc.end();
	return done;
}
