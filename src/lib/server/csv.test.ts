import { describe, expect, it } from 'vitest';
import { csvRecords, parseCsv, toCsv } from './csv';

describe('toCsv', () => {
	it('starts with a BOM, quotes separators and neutralises formulas', () => {
		const out = toCsv([
			['name', 'note'],
			['Rahim, Uddin', 'said "hi"\nbye'],
			['=HYPERLINK("x")', '+1'],
			['-2', '@SUM(A1)'],
			[null, 7],
			[-2, -0.5]
		]);
		expect(out.startsWith('﻿')).toBe(true);
		expect(out.slice(1).split('\r\n')).toEqual([
			'name,note',
			'"Rahim, Uddin","said ""hi""\nbye"',
			`"'=HYPERLINK(""x"")",'+1`,
			"'-2,'@SUM(A1)",
			',7',
			'-2,-0.5',
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

describe('csvRecords', () => {
	it('maps columns in any order, trims and strips the export formula guard', () => {
		expect(
			csvRecords(
				[
					['B', 'a'],
					[' x ', "'-2"]
				],
				['a', 'b'],
				5
			)
		).toEqual([{ line: 2, v: { a: '-2', b: 'x' } }]);
	});

	it('rejects a wrong header, an empty body and too many rows', () => {
		const rows = (f: () => unknown) => {
			try {
				f();
			} catch (e) {
				return (e as { rows: unknown }).rows;
			}
		};
		expect(rows(() => csvRecords([['a']], ['a', 'b'], 5))).toEqual([{ line: 1, message: 'Header must be a,b.' }]);
		expect(rows(() => csvRecords([['a', 'b', 'c']], ['a', 'b'], 5))).toEqual([
			{ line: 1, message: 'Header must be a,b.' }
		]);
		expect(rows(() => csvRecords([['a', 'b']], ['a', 'b'], 5))).toEqual([
			{ line: 2, message: 'The file has no rows to import.' }
		]);
		expect(
			rows(() =>
				csvRecords(
					[
						['a', 'b'],
						['1', '2'],
						['3', '4']
					],
					['a', 'b'],
					1
				)
			)
		).toEqual([{ line: 1, message: 'Import at most 1 rows at a time.' }]);
	});

	it('rejects rows with more filled cells than the header, such as an unquoted comma', () => {
		const run = () =>
			csvRecords(
				[
					['date', 'name'],
					['2031-04-01', 'Eid', ' Day'],
					['2031-04-02', 'Ok', ''],
					['2031-04-03', 'Fine']
				],
				['date', 'name'],
				5
			);
		expect(() => run()).toThrow();
		try {
			run();
		} catch (e) {
			expect((e as { rows: unknown }).rows).toEqual([
				{ line: 2, message: 'This row has more cells than the header. Put quotes around values that contain commas.' }
			]);
		}
	});
});
