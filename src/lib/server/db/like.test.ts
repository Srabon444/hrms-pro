import { describe, expect, it } from 'vitest';
import { containsPattern, likeEscape } from './like';

describe('likeEscape', () => {
	it('escapes LIKE wildcards and the escape character', () => {
		expect(likeEscape('50%_off\\')).toBe('50\\%\\_off\\\\');
	});
	it('wraps a value for a contains match', () => {
		expect(containsPattern('a%b')).toBe('%a\\%b%');
		expect(containsPattern('plain')).toBe('%plain%');
	});
});
