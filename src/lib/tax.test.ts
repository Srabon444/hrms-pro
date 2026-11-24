import { describe, expect, it } from 'vitest';
import {
	annualTax,
	DEFAULT_TAX_YEAR,
	fiscalMonths,
	fiscalYearOf,
	formatBands,
	parseBands,
	slabTax,
	type Band
} from './tax';

const general = parseBands(DEFAULT_TAX_YEAR.bands.general) as Band[];
const rule = { bands: general, exemptionCap: 45_000_000, exemptionDivisor: 3, minimumTax: 500_000 };

describe('fiscal year', () => {
	it('runs July to June', () => {
		expect(fiscalYearOf('2026-07-01')).toBe('2026-27');
		expect(fiscalYearOf('2026-06-30')).toBe('2025-26');
		expect(fiscalYearOf('2099-12-31')).toBe('2099-00');
		expect(fiscalMonths('2026-27')).toEqual([
			'2026-07',
			'2026-08',
			'2026-09',
			'2026-10',
			'2026-11',
			'2026-12',
			'2027-01',
			'2027-02',
			'2027-03',
			'2027-04',
			'2027-05',
			'2027-06'
		]);
	});
});

describe('slabs', () => {
	it('taxes each band at its own rate', () => {
		expect(slabTax(0, general)).toBe(0);
		expect(slabTax(35_000_000, general)).toBe(0);
		expect(slabTax(45_000_000, general)).toBe(500_000);
		expect(slabTax(85_000_000, general)).toBe(500_000 + 4_000_000);
		expect(slabTax(500_000_000, general)).toBe(
			500_000 + 4_000_000 + 7_500_000 + 10_000_000 + 50_000_000 + 0.3 * (500_000_000 - 385_000_000)
		);
		expect(slabTax(35_000_001, general)).toBe(0);
		expect(slabTax(35_000_010, general)).toBe(1);
	});

	it('takes a third of income off, capped, then applies rebate and minimum tax', () => {
		expect(annualTax(52_500_000, 0, rule)).toBe(0);
		expect(annualTax(60_000_000, 0, rule)).toBe(500_000);
		expect(annualTax(60_000_000, 100_000, rule)).toBe(500_000);
		expect(annualTax(150_000_000, 0, rule)).toBe(slabTax(105_000_000, general));
		expect(annualTax(150_000_000, 1_000_000, rule)).toBe(slabTax(105_000_000, general) - 1_000_000);
		expect(annualTax(150_000_000, 99_000_000, rule)).toBe(500_000);
		expect(annualTax(150_000_000, 0, { ...rule, exemptionCap: 0 })).toBe(slabTax(150_000_000, general));
		expect(annualTax(150_000_000, 0, { ...rule, exemptionDivisor: 2 })).toBe(slabTax(105_000_000, general));
		expect(annualTax(90_000_000, 0, { ...rule, exemptionDivisor: 2 })).toBe(slabTax(45_000_000, general));
	});
});

describe('band text', () => {
	it('round-trips taka widths and percent rates', () => {
		expect(general[0]).toEqual({ width: 35_000_000, rateBp: 0 });
		expect(general.at(-1)).toEqual({ width: null, rateBp: 3000 });
		expect(formatBands(general)).toBe(DEFAULT_TAX_YEAR.bands.general);
		expect(parseBands(' 100 2.5 \n\n rest 100 ')).toEqual([
			{ width: 10_000, rateBp: 250 },
			{ width: null, rateBp: 10_000 }
		]);
	});

	it('explains bad input', () => {
		expect(parseBands('')).toMatch(/between 1 and 12/);
		expect(parseBands(Array(13).fill('1 1').join('\n'))).toMatch(/between 1 and 12/);
		expect(parseBands('100 5')).toMatch(/last band must be "rest"/);
		expect(parseBands('rest 5\n100 5')).toMatch(/Only the last/);
		expect(parseBands('100 101\nrest 1')).toMatch(/Write each band/);
		expect(parseBands('abc 5\nrest 1')).toMatch(/Write each band/);
		expect(parseBands('0 5\nrest 1')).toMatch(/more than zero/);
		expect(parseBands('rest 1.005')).toMatch(/Write each band/);
	});
});
