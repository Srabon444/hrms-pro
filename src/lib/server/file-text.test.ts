import { describe, expect, it } from 'vitest';
import { FILE_TEXT_MAX_CHARS } from './db/schema';
import { cleanText } from './file-text';

describe('cleanText', () => {
	it('drops control and bidi characters, keeps line breaks and collapses spaces', () => {
		expect(cleanText('  Pay\u0000day \u202eis\u2066  the\t\t1st\r\n\n\n\nof   month  ')).toBe(
			'Pay day is the 1st\n\nof month'
		);
	});

	it('joins words split by soft hyphens or zero-width spaces and turns line separators into breaks', () => {
		expect(cleanText('sal\u00adary\u200b pay\u200e\ufeff\u2028next\u2029line')).toBe('salary pay\nnext\nline');
	});

	it('caps the stored text', () => {
		expect(cleanText('a'.repeat(FILE_TEXT_MAX_CHARS + 50))).toHaveLength(FILE_TEXT_MAX_CHARS);
	});
});
