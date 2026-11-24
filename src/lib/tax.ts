export const TAX_CATEGORIES = ['general', 'female_senior', 'disabled', 'freedom_fighter'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];
export type Band = { width: number | null; rateBp: number };

export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
	general: 'General',
	female_senior: 'Women, third gender and 65+',
	disabled: 'Persons with disability',
	freedom_fighter: 'Gazetted freedom fighters'
};

export const fiscalYearOf = (date: string) => {
	const y = Number(date.slice(0, 4));
	const start = Number(date.slice(5, 7)) >= 7 ? y : y - 1;
	return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

export const fiscalMonths = (fy: string) => {
	const start = Number(fy.slice(0, 4));
	return Array.from({ length: 12 }, (_, i) => {
		const m = ((6 + i) % 12) + 1;
		return `${i < 6 ? start : start + 1}-${String(m).padStart(2, '0')}`;
	});
};

export function slabTax(taxable: number, bands: Band[]) {
	let left = taxable;
	let tax = 0;
	for (const b of bands) {
		const part = b.width === null ? left : Math.min(left, b.width);
		tax += (part * b.rateBp) / 10_000;
		left -= part;
	}
	return Math.round(tax);
}

export type TaxRule = { bands: Band[]; exemptionCap: number; exemptionDivisor: number; minimumTax: number };

export function annualTax(income: number, rebate: number, rule: TaxRule) {
	const exempt = Math.min(Math.floor(income / rule.exemptionDivisor), rule.exemptionCap);
	const gross = slabTax(income - exempt, rule.bands);
	return gross === 0 ? 0 : Math.max(gross - rebate, rule.minimumTax);
}

const LINE = /^(rest|\d{1,9})\s+(\d{1,2}(?:\.\d{1,2})?|100)$/;

export function parseBands(text: string): Band[] | string {
	const lines = text
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	if (!lines.length || lines.length > 12) return 'Enter between 1 and 12 bands.';
	const bands: Band[] = [];
	for (const [i, line] of lines.entries()) {
		const match = LINE.exec(line);
		if (!match) return `Write each band as "<taka> <rate %>", or "rest <rate %>" last.`;
		const rest = match[1] === 'rest';
		if (rest !== (i === lines.length - 1)) return 'Only the last band is "rest", and the last band must be "rest".';
		const width = rest ? null : Number(match[1]) * 100;
		if (width === 0) return 'Band widths must be more than zero.';
		bands.push({ width, rateBp: Math.round(Number(match[2]) * 100) });
	}
	return bands;
}

export const formatBands = (bands: Band[]) =>
	bands.map((b) => `${b.width === null ? 'rest' : b.width / 100} ${b.rateBp / 100}`).join('\n');

const BANDS_ABOVE = '100000 5\n400000 10\n500000 15\n500000 20\n2000000 25\nrest 30';

export const DEFAULT_TAX_YEAR = {
	minimumTax: 500_000,
	exemptionCap: 45_000_000,
	exemptionDivisor: 3,
	bands: {
		general: `350000 0\n${BANDS_ABOVE}`,
		female_senior: `400000 0\n${BANDS_ABOVE}`,
		disabled: `475000 0\n${BANDS_ABOVE}`,
		freedom_fighter: `500000 0\n${BANDS_ABOVE}`
	} satisfies Record<TaxCategory, string>
};
