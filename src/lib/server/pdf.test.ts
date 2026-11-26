import { expect, it } from 'vitest';
import { fontRuns, pdfDoc, write } from './pdf';

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
