import { AppError } from './errors';

const BOM = '﻿';
const FORMULA = /^[=+\-@\t\r]/;

const cell = (v: string | number | null | undefined) => {
	let s = v == null ? '' : String(v);
	if (typeof v !== 'number' && FORMULA.test(s)) s = `'${s}`;
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

export type ImportRowError = { line: number; message: string };

const SHOWN_ERRORS = 50;

export class ImportFailed extends AppError {
	rows: ImportRowError[];
	constructor(rows: ImportRowError[]) {
		super(
			'import_failed',
			rows.length > SHOWN_ERRORS
				? `Nothing was imported. ${rows.length} rows have problems; the first ${SHOWN_ERRORS} are below. Fix them and upload the file again.`
				: 'Nothing was imported. Fix the rows below and upload the file again.',
			400
		);
		this.rows = rows.slice(0, SHOWN_ERRORS);
	}
}

const MAX_CSV_BYTES = 1024 * 1024;

export async function readCsvUpload(file: FormDataEntryValue | null): Promise<string[][]> {
	if (!(file instanceof File) || file.size === 0) throw new AppError('no_file', 'Choose a CSV file.', 400);
	if (file.size > MAX_CSV_BYTES) throw new AppError('too_large', 'CSV files can be at most 1 MB.', 413);
	try {
		return parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
	} catch {
		throw new AppError('bad_csv', 'That file is not a valid UTF-8 CSV.', 400);
	}
}

export const unformula = (v: string) => v.trim().replace(/^'(?=[=+\-@\t\r])/, '');

export function csvRecords<K extends string>(table: string[][], columns: readonly K[], max: number) {
	const [header, ...body] = table;
	const cols = (header ?? []).map((h) => h.trim().toLowerCase());
	if (cols.length !== columns.length || columns.some((c) => !cols.includes(c)))
		throw new ImportFailed([{ line: 1, message: `Header must be ${columns.join(',')}.` }]);
	if (!body.length) throw new ImportFailed([{ line: 2, message: 'The file has no rows to import.' }]);
	if (body.length > max) throw new ImportFailed([{ line: 1, message: `Import at most ${max} rows at a time.` }]);
	const ragged = body.flatMap((cells, i) =>
		cells.slice(cols.length).some((c) => c.trim())
			? [
					{
						line: i + 2,
						message: 'This row has more cells than the header. Put quotes around values that contain commas.'
					}
				]
			: []
	);
	if (ragged.length) throw new ImportFailed(ragged);
	return body.map((cells, i) => ({
		line: i + 2,
		v: Object.fromEntries(columns.map((c) => [c, unformula(cells[cols.indexOf(c)] ?? '')])) as Record<K, string>
	}));
}
