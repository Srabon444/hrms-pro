import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv';

describe('toCsv', () => {
	it('starts with a BOM, quotes separators and neutralises formulas', () => {
		const out = toCsv([
			['name', 'note'],
			['Rahim, Uddin', 'said "hi"\nbye'],
			['=HYPERLINK("x")', '+1'],
			['-2', '@SUM(A1)'],
			[null, 7]
		]);
		expect(out.startsWith('﻿')).toBe(true);
		expect(out.slice(1).split('\r\n')).toEqual([
			'name,note',
			'"Rahim, Uddin","said ""hi""\nbye"',
			`"'=HYPERLINK(""x"")",'+1`,
			"'-2,'@SUM(A1)",
			',7',
			''
		]);
	});
});

describe('parseCsv', () => {
	it('round-trips quoted fields, CRLF and LF and drops blank lines', () => {
		const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n\n,last');
		expect(rows).toEqual([
			['a', 'b'],
			['x, y', 'say "hi"\nthere'],
			['', 'last']
		]);
	});

	it('handles a trailing newline and rejects an unterminated quote', () => {
		expect(parseCsv('a,b\n1,2\n')).toEqual([
			['a', 'b'],
			['1', '2']
		]);
		expect(() => parseCsv('a,"open\n1,2')).toThrow('unterminated_quote');
	});
});
