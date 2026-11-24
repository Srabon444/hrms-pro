import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

const fontFile = (subset: string) =>
	createRequire(import.meta.url).resolve(
		`@fontsource/noto-sans-bengali/files/noto-sans-bengali-${subset}-400-normal.woff`
	);

const BENGALI = /([ঀ-৿‌‍]+)/;

export function pdfDoc(title: string) {
	const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: title } });
	doc.registerFont('latin', fontFile('latin'));
	doc.registerFont('bn', fontFile('bengali'));
	const chunks: Buffer[] = [];
	doc.on('data', (c: Buffer) => chunks.push(c));
	const done = new Promise<Uint8Array>((resolve) =>
		doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
	);
	return { doc, done };
}

export function write(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width?: number, align = 'left') {
	const runs = text.split(BENGALI).filter(Boolean);
	runs.forEach((run, i) => {
		doc.font(BENGALI.test(run) ? 'bn' : 'latin');
		const opts = { continued: i < runs.length - 1, width, align: align as 'left' };
		if (i === 0) doc.text(run, x, y, opts);
		else doc.text(run, opts);
	});
}
