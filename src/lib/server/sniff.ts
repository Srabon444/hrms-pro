const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const ZIP_TYPES: Record<string, string> = {
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

export function sniffType(bytes: Uint8Array, fileName: string): string | null {
	if (starts(bytes, ascii('%PDF-'))) return 'application/pdf';
	if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
	if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	if (starts(bytes, ascii('RIFF')) && starts(bytes, ascii('WEBP'), 8)) return 'image/webp';
	if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) return ZIP_TYPES[fileName.split('.').pop()!.toLowerCase()] ?? null;
	return null;
}

export function safeFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? '';
	return (
		base
			.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '')
			.trim()
			.slice(0, 200) || 'file'
	);
}

export const pdfName = (name: string) => {
	const safe = safeFileName(name).slice(0, 196);
	return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
};
