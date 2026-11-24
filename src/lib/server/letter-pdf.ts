import { pdfDoc, write } from './pdf';

export const longDate = (d: string | null) =>
	d
		? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
				day: 'numeric',
				month: 'long',
				year: 'numeric',
				timeZone: 'UTC'
			})
		: null;

export function renderLetterPdf(l: {
	company: string;
	number: number;
	issuedOn: string;
	subject: string;
	body: string;
}): Promise<Uint8Array> {
	const { doc, done } = pdfDoc(l.subject);
	doc.fontSize(16);
	write(doc, l.company, 48, 48);
	doc.fontSize(10);
	write(doc, `Ref: L-${String(l.number).padStart(5, '0')}`, 48, 78);
	write(doc, longDate(l.issuedOn)!, 48, 78, 499, 'right');
	doc.fontSize(13);
	write(doc, l.subject, 48, 116, 499);
	doc.fontSize(11);
	let y = doc.y + 16;
	for (const para of l.body.split('\n')) {
		if (para.trim()) write(doc, para, 48, y, 499);
		y = doc.y + (para.trim() ? 6 : 10);
	}
	doc.end();
	return done;
}
