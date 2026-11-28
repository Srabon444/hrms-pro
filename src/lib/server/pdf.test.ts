import { expect, it } from 'vitest';
import { centred, fontRuns, pdfDoc, write } from './pdf';

it('picks a font that has the glyphs for each script', () => {
	expect(fontRuns('Anna Müller — €5')).toEqual([{ font: 'latin', text: 'Anna Müller — €5' }]);
	expect(fontRuns('Привет')).toEqual([{ font: 'cyrillic', text: 'Привет' }]);
	expect(fontRuns('Ґанна ґ')).toEqual([
		{ font: 'cyrillic', text: 'Ґанна' },
		{ font: 'latin', text: ' ' },
		{ font: 'cyrillic', text: 'ґ' }
	]);
	expect(fontRuns('Nguye\u0302\u0303n')).toEqual(fontRuns('Nguyễn'));
	expect(fontRuns('Γειά')).toEqual([{ font: 'greek', text: 'Γειά' }]);
	expect(fontRuns('ễ')).toEqual([{ font: 'vietnamese', text: 'ễ' }]);
	expect(fontRuns('Łź')).toEqual([{ font: 'latin-ext', text: 'Łź' }]);
	expect(fontRuns('नमस्ते')).toEqual([{ font: 'devanagari', text: 'नमस्ते' }]);
	expect(fontRuns('র‍্যাব')).toEqual([{ font: 'bengali', text: 'র‍্যাব' }]);
	expect(fontRuns('Olga Привет').map((r) => r.font)).toEqual(['latin', 'cyrillic']);
	expect(fontRuns('')).toEqual([]);
});

it('embeds every script of a mixed line in the PDF', async () => {
	const { doc, done } = pdfDoc('Mixed');
	write(doc, 'Anna — Ольга — Γιώργος — Nguyễn — Łukasz — आनंद — আনা', 48, 48);
	doc.end();
	const pdf = Buffer.from(await done).toString('latin1');
	expect(pdf.startsWith('%PDF-')).toBe(true);
	expect(pdf).toContain('NotoSansBengali');
	expect(pdf.match(/\/FontFile2? /g)!.length).toBe(7);
});

it('centres a mixed-script line as one run sequence and wraps long text onto new lines', async () => {
	const { doc, done } = pdfDoc('Centred');
	const calls: { text: string; x?: number; align?: string }[] = [];
	const text = doc.text.bind(doc);
	doc.text = ((t: string, x?: number | object, y?: number, o?: PDFKit.Mixins.TextOptions) => {
		calls.push(
			typeof x === 'number' ? { text: t, x, align: o?.align } : { text: t, align: (x as { align?: string })?.align }
		);
		return typeof x === 'number' ? text(t, x, y, o) : text(t, x);
	}) as typeof doc.text;
	doc.fontSize(22);
	const next = centred(doc, 'Nguyễn Thị রহিম', 48, 100, 499);
	expect(calls.map((c) => c.text).join('')).toBe('Nguyễn Thị রহিম');
	expect(calls.filter((c) => c.x !== undefined)).toHaveLength(1);
	expect(calls[0].x).toBeGreaterThan(150);
	expect(calls.every((c) => c.align === 'left')).toBe(true);
	expect(next).toBeCloseTo(100 + doc.currentLineHeight(true));
	calls.length = 0;
	const wrapped = centred(doc, 'W'.repeat(160), 48, 100, 499);
	expect(calls.filter((c) => c.x !== undefined).length).toBeGreaterThan(3);
	expect(calls.every((c) => c.x === undefined || c.x >= 48)).toBe(true);
	expect(wrapped).toBeGreaterThan(100 + 3 * doc.currentLineHeight(true));
	doc.end();
	expect(
		Buffer.from(await done)
			.toString('latin1')
			.startsWith('%PDF-')
	).toBe(true);
});
