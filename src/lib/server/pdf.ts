import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import PDFDocument from 'pdfkit';

type Face = { name: string; file: string; ranges: [number, number][] };

const resolve = createRequire(import.meta.url).resolve;

function faces(pkg: string, only?: string): Face[] {
	const css = resolve(`@fontsource/${pkg}/400.css`);
	const found = [
		...readFileSync(css, 'utf8').matchAll(/files\/([\w-]+)-400-normal\.woff\)[^;]*;\s*unicode-range: ([^;]+);/g)
	];
	return found
		.map(([, base, ranges]) => ({
			name: base.slice(pkg.length + 1),
			file: join(dirname(css), 'files', `${base}-400-normal.woff`),
			ranges: ranges.split(',').map((r) => {
				const [lo, hi = lo] = r.trim().slice(2).split('-');
				return [parseInt(lo, 16), parseInt(hi, 16)] as [number, number];
			})
		}))
		.filter((f) => !only || f.name === only);
}

const rank = (f: Face) => (f.name === 'latin' ? 0 : f.name.endsWith('-ext') ? 2 : 1);
const FACES = [...faces('noto-sans'), ...faces('noto-sans-bengali', 'bengali')].sort((a, b) => rank(a) - rank(b));

const covers = (face: Face, cp: number) => face.ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

export function fontRuns(text: string): { font: string; text: string }[] {
	const runs: { font: string; text: string }[] = [];
	for (const ch of text.normalize('NFC')) {
		const cp = ch.codePointAt(0)!;
		const last = runs.at(-1);
		const current = last && FACES.find((f) => f.name === last.font);
		if (last && current && covers(current, cp)) last.text += ch;
		else runs.push({ font: (FACES.find((f) => covers(f, cp)) ?? FACES[0]).name, text: ch });
	}
	return runs;
}

const locked = (password: string) => ({
	pdfVersion: '1.7ext3' as const,
	userPassword: password,
	ownerPassword: randomBytes(32).toString('base64url'),
	permissions: { printing: 'highResolution' as const, copying: true }
});

export function canLockPdf(password: string): boolean {
	try {
		new PDFDocument(locked(password));
		return true;
	} catch {
		return false;
	}
}

export function pdfDoc(title: string, password?: string) {
	const doc = new PDFDocument({
		size: 'A4',
		margin: 48,
		info: { Title: title },
		...(password && locked(password))
	});
	for (const face of FACES) doc.registerFont(face.name, face.file);
	const chunks: Buffer[] = [];
	doc.on('data', (c: Buffer) => chunks.push(c));
	const done = new Promise<Uint8Array>((resolve) =>
		doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
	);
	return { doc, done };
}

export function write(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width?: number, align = 'left') {
	const runs = fontRuns(text);
	runs.forEach((run, i) => {
		doc.font(run.font);
		const opts = { continued: i < runs.length - 1, width, align: align as 'left' };
		if (i === 0) doc.text(run.text, x, y, opts);
		else doc.text(run.text, opts);
	});
}

const runsWidth = (doc: PDFKit.PDFDocument, text: string) =>
	fontRuns(text).reduce((w, r) => w + doc.font(r.font).widthOfString(r.text), 0);

export function centred(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number): number {
	const fits = (t: string) => runsWidth(doc, t) <= width;
	const pieces = [...text.split(/\s+/).filter(Boolean)].flatMap((word) =>
		fits(word)
			? [word]
			: [...word].reduce<string[]>((out, ch) => {
					if (out.length && fits(out[out.length - 1] + ch)) out[out.length - 1] += ch;
					else out.push(ch);
					return out;
				}, [])
	);
	const lines = pieces.reduce<string[]>((out, word) => {
		if (out.length && fits(`${out[out.length - 1]} ${word}`)) out[out.length - 1] += ` ${word}`;
		else out.push(word);
		return out;
	}, []);
	const height = doc.currentLineHeight(true);
	lines.forEach((line, i) => {
		const start = x + Math.max(0, (width - runsWidth(doc, line)) / 2);
		write(doc, line, start, y + i * height, x + width - start + 4);
	});
	return y + lines.length * height;
}
