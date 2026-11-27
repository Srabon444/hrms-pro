import { describe, expect, it } from 'vitest';
import { mapCv, mapDocument, mapReceipt } from './assist';
import { fakeTransport } from './fake';

const ctx = {
	currency: 'BDT',
	today: '2026-11-27',
	categories: [
		{ id: 'c-meals', name: 'Meals' },
		{ id: 'c-travel', name: 'Travel' }
	]
};
const receipt = {
	merchant: 'City Cafe',
	spentOn: '2026-01-15',
	amount: 450.5,
	currency: 'BDT',
	categoryGuess: 'meals'
};

describe('receipt mapping', () => {
	it('fills every field when the receipt is in the tenant currency', () => {
		expect(mapReceipt(receipt, ctx)).toEqual({
			fill: { description: 'City Cafe', spentOn: '2026-01-15', amount: '450.50', categoryId: 'c-meals' },
			note: undefined
		});
	});

	it('keeps the amount out when the currency differs or is unknown', () => {
		const usd = mapReceipt({ ...receipt, currency: 'USD' }, ctx);
		expect(usd.fill.amount).toBeUndefined();
		expect(usd.note).toBe('The receipt is not in BDT, so enter the amount yourself.');
		expect(mapReceipt({ ...receipt, currency: '' }, ctx).fill.amount).toBe('450.50');
	});

	it('drops future, invalid and missing dates', () => {
		const future = mapReceipt({ ...receipt, spentOn: '2026-11-28' }, ctx);
		expect(future.fill.spentOn).toBeUndefined();
		expect(future.note).toMatch(/date/);
		expect(mapReceipt({ ...receipt, spentOn: '2026-02-30' }, ctx).fill.spentOn).toBeUndefined();
		expect(mapReceipt({ ...receipt, spentOn: '' }, ctx)).toMatchObject({ note: undefined });
	});

	it('drops amounts that the claim form would reject', () => {
		for (const amount of [0, -5, 10_000_000, Number.NaN])
			expect(mapReceipt({ ...receipt, amount }, ctx).fill.amount).toBeUndefined();
		expect(mapReceipt({ ...receipt, amount: 9_999_999.99 }, ctx).fill.amount).toBe('9999999.99');
		expect(mapReceipt({ ...receipt, amount: 12 }, ctx).fill.amount).toMatch(/^\d{1,7}(\.\d{1,2})?$/);
	});

	it('only picks an active category by exact name', () => {
		expect(mapReceipt({ ...receipt, categoryGuess: 'Meal' }, ctx).fill.categoryId).toBeUndefined();
		expect(mapReceipt({ ...receipt, categoryGuess: '' }, ctx).fill.categoryId).toBeUndefined();
		expect(mapReceipt({ ...receipt, categoryGuess: 'TRAVEL' }, ctx).fill.categoryId).toBe('c-travel');
	});
});

describe('cv mapping', () => {
	const cv = {
		fullName: 'Rina Akter',
		email: 'Rina.Akter@Example.com',
		phone: '+880 1711 000000',
		currentTitle: 'QA Engineer',
		yearsExperience: 4,
		skills: ['Playwright', 'SQL', 'SQL', 'a,b']
	};

	it('fills the candidate form with valid values only', () => {
		expect(mapCv(cv, false)).toEqual({
			fill: {
				fullName: 'Rina Akter',
				email: 'rina.akter@example.com',
				phone: '+880 1711 000000',
				tags: 'Playwright, SQL, a b',
				notes: 'QA Engineer, 4 years of experience'
			},
			note: undefined
		});
		const bad = mapCv({ ...cv, email: 'not-an-email', phone: 'call me', yearsExperience: 200, skills: [] }, false);
		expect(bad.fill).toEqual({ fullName: 'Rina Akter', notes: 'QA Engineer' });
	});

	it('keeps at most ten tags and warns about a duplicate email', () => {
		const many = mapCv({ ...cv, skills: Array.from({ length: 14 }, (_, i) => `s${i}`) }, true);
		expect(many.fill.tags!.split(', ')).toHaveLength(10);
		expect(many.note).toBe('That email is already a candidate for this opening.');
	});
});

describe('document mapping', () => {
	it('fills title and a valid expiry only', () => {
		expect(mapDocument({ title: 'AWS Certified Developer', expiresOn: '2029-03-31' }).fill).toEqual({
			title: 'AWS Certified Developer',
			expiresOn: '2029-03-31'
		});
		expect(mapDocument({ title: '', expiresOn: 'soon' }).fill).toEqual({});
	});
});

describe('fake provider tasks', () => {
	const signal = new AbortController().signal;
	it('answers each task with its canned output', async () => {
		const ocr = await fakeTransport(
			'm',
			'k',
			{ system: 's', parts: [], schema: { type: 'object' }, maxOutputTokens: 10, task: 'receipt' },
			signal
		);
		expect(ocr.json).toMatchObject({ merchant: 'City Cafe', amount: 450.5 });
		const text = await fakeTransport('m', 'k', { system: 's', parts: [], maxOutputTokens: 10, task: 'reply' }, signal);
		expect(text.json).toBeUndefined();
		expect(text.text).toMatch(/^Thanks for raising this/);
	});
});
