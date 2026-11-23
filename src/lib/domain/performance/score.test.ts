import { describe, expect, it } from 'vitest';
import { scoreLabel, weightedScore } from './score';

describe('weightedScore', () => {
	it('weights each rating and returns hundredths', () => {
		expect(
			weightedScore([
				{ weight: 60, rating: 4 },
				{ weight: 40, rating: 3 }
			])
		).toBe(360);
	});
	it('rounds to the nearest hundredth when weights do not total 100', () => {
		expect(
			weightedScore([
				{ weight: 1, rating: 5 },
				{ weight: 2, rating: 3 }
			])
		).toBe(367);
	});
	it('returns null until every goal is rated', () => {
		expect(
			weightedScore([
				{ weight: 50, rating: 4 },
				{ weight: 50, rating: null }
			])
		).toBeNull();
		expect(weightedScore([])).toBeNull();
		expect(weightedScore([{ weight: 0, rating: 3 }])).toBeNull();
	});
	it('labels hundredths with two decimals', () => {
		expect(scoreLabel(360)).toBe('3.60');
		expect(scoreLabel(500)).toBe('5.00');
	});
});
