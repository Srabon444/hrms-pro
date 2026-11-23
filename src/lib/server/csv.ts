const BOM = '﻿';
const FORMULA = /^[=+\-@\t\r]/;

const cell = (v: string | number | null | undefined) => {
	let s = v == null ? '' : String(v);
	if (FORMULA.test(s)) s = `'${s}`;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (rows: (string | number | null | undefined)[][]): string =>
	BOM + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

export function parseCsv(text: string): string[][] {
	const src = text.startsWith(BOM) ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quoted) {
			if (c === '"' && src[i + 1] === '"') field += src[++i];
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"' && field === '') quoted = true;
		else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && src[i + 1] === '\n') i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else field += c;
	}
	if (quoted) throw new Error('unterminated_quote');
	if (field !== '' || row.length) rows.push([...row, field]);
	return rows.filter((r) => r.some((v) => v.trim() !== ''));
}
