import { describe, expect, it } from 'vitest';
import { safeFileName, sniffType } from './sniff';

const bytes = (...parts: (number[] | string)[]) =>
	new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe('sniffType', () => {
	it('recognises allowed files by their content, not their name', () => {
		expect(sniffType(bytes('%PDF-1.7'), 'scan.png')).toBe('application/pdf');
		expect(sniffType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]), 'a.pdf')).toBe('image/png');
		expect(sniffType(bytes([0xff, 0xd8, 0xff, 0xe0]), 'a')).toBe('image/jpeg');
		expect(sniffType(bytes('RIFF', [0, 0, 0, 0], 'WEBP'), 'a')).toBe('image/webp');
		expect(sniffType(bytes('PK', [3, 4]), 'Offer.DOCX')).toMatch(/wordprocessingml/);
	});

	it('refuses everything else, including renamed archives and scripts', () => {
		expect(sniffType(bytes('PK', [3, 4]), 'payload.zip')).toBeNull();
		expect(sniffType(bytes('PK', [3, 4]), 'noext')).toBeNull();
		expect(sniffType(bytes('<svg onload=alert(1)>'), 'a.png')).toBeNull();
		expect(sniffType(bytes('MZ'), 'a.pdf')).toBeNull();
		expect(sniffType(new Uint8Array(), 'a.pdf')).toBeNull();
		expect(sniffType(bytes('RIFF', [0, 0, 0, 0], 'WAVE'), 'a.webp')).toBeNull();
	});
});

describe('safeFileName', () => {
	it('keeps only a clean base name', () => {
		expect(safeFileName('C:\\Users\\me\\scan.pdf')).toBe('scan.pdf');
		expect(safeFileName('../../etc/passwd')).toBe('passwd');
		expect(safeFileName('bad\r\nname.pdf')).toBe('badname.pdf');
		expect(safeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
		expect(safeFileName('  /  ')).toBe('file');
		expect(safeFileName('a'.repeat(300))).toHaveLength(200);
	});
});
