import { expect, it } from 'vitest';
import { longDate, renderLetterPdf } from './letter-pdf';

it('writes dates the way letters spell them', () => {
	expect(longDate('2026-01-01')).toBe('1 January 2026');
	expect(longDate('2026-12-31')).toBe('31 December 2026');
	expect(longDate(null)).toBeNull();
});

it('renders a letter that flows onto more pages when it is long', async () => {
	const render = (body: string) =>
		renderLetterPdf({ company: 'Acme Ltd', number: 7, issuedOn: '2026-11-24', subject: 'Salary certificate', body });
	const short = Buffer.from(await render('প্রিয় আনা,\n\nThis is to certify.')).toString('latin1');
	expect(short.startsWith('%PDF-')).toBe(true);
	expect(short.match(/\/Type \/Page\b/g)).toHaveLength(1);
	expect(short).toContain('NotoSansBengali');
	const long = Buffer.from(await render(Array(120).fill('A line of the letter.').join('\n'))).toString('latin1');
	expect(long.match(/\/Type \/Page\b/g)!.length).toBeGreaterThan(1);
});
