import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enps, hiddenSlices, readAnswers } from './surveys';

describe('eNPS', () => {
	it('is percent promoters minus percent detractors', () => {
		const counts = Array(11).fill(0);
		counts[10] = 3;
		counts[9] = 2;
		counts[8] = 2;
		counts[6] = 2;
		counts[0] = 1;
		expect(enps(counts)).toEqual({ total: 10, promoters: 50, passives: 20, detractors: 30, score: 20 });
		expect(enps(Array(11).fill(0)).score).toBe(0);
		expect(enps([0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0]).score).toBe(-100);
	});
});

describe('slice suppression', () => {
	const map = (o: Record<string, number>) => new Map(Object.entries(o));
	it('hides small slices', () => {
		expect([...hiddenSlices(map({ a: 9, b: 3, c: 2, d: 12 }), 5)].sort()).toEqual(['b', 'c']);
		expect([...hiddenSlices(map({ a: 10, b: 1, c: 2 }), 5)].sort()).toEqual(['a', 'b', 'c']);
		expect([...hiddenSlices(map({ a: 10, b: 1, c: 2, d: 6 }), 5)].sort()).toEqual(['b', 'c', 'd']);
		expect(hiddenSlices(map({ a: 9, d: 12 }), 5).size).toBe(0);
	});
	it('hides more slices until the hidden ones add up to the limit', () => {
		expect([...hiddenSlices(map({ a: 9, b: 3, d: 12 }), 5)].sort()).toEqual(['a', 'b']);
		expect([...hiddenSlices(map({ a: 7, b: 7, c: 4, d: 20 }), 5)].sort()).toEqual(['a', 'c']);
		expect([...hiddenSlices(map({ a: 4 }), 5)]).toEqual(['a']);
	});
});

describe('answers', () => {
	const qs = [
		{ id: 'a', kind: 'scale' as const, options: [], required: true },
		{ id: 'b', kind: 'enps' as const, options: [], required: true },
		{ id: 'c', kind: 'choice' as const, options: ['x', 'y'], required: false },
		{ id: 'd', kind: 'text' as const, options: [], required: false }
	];
	const fails = (raw: Record<string, string>) => {
		try {
			readAnswers(qs, raw);
			return null;
		} catch (e) {
			return (e as Error).message;
		}
	};
	it('reads valid answers and skips empty optional ones', () => {
		expect(readAnswers(qs, { q_a: '5', q_b: '0', q_c: '1', q_d: ' hi ' })).toEqual([
			{ questionId: 'a', valueNum: 5, valueText: null },
			{ questionId: 'b', valueNum: 0, valueText: null },
			{ questionId: 'c', valueNum: 1, valueText: null },
			{ questionId: 'd', valueNum: null, valueText: 'hi' }
		]);
		expect(readAnswers(qs, { q_a: '1', q_b: '10' })).toHaveLength(2);
	});
	it('refuses out-of-range, malformed and missing answers', () => {
		expect(fails({ q_a: '0', q_b: '5' })).toMatch(/Pick one/);
		expect(fails({ q_a: '3', q_b: '11' })).toMatch(/Pick one/);
		expect(fails({ q_a: '3', q_b: '5', q_c: '2' })).toMatch(/Pick one/);
		expect(fails({ q_a: '3.5', q_b: '5' })).toMatch(/Pick one/);
		expect(fails({ q_a: '-1', q_b: '5' })).toMatch(/Pick one/);
		expect(fails({ q_b: '5' })).toMatch(/required/);
		expect(fails({ q_a: '3', q_b: '5', q_d: 'x'.repeat(2001) })).toMatch(/2000/);
		expect(fails({ q_a: '3', q_b: '5', q_d: 'a\0b' })).toMatch(/unsupported/);
	});
});

describe('anonymity by construction', () => {
	const sources = globSync('src/**/*.{ts,svelte}').filter((f) => !f.endsWith('.test.ts'));
	const queries = (src: string, table: string) => {
		const out: string[] = [];
		let i = src.indexOf(`.from(${table})`);
		while (i >= 0) {
			const start = src.lastIndexOf('tx', i);
			out.push(src.slice(start, src.indexOf(';', i) < 0 ? undefined : src.indexOf(';', i)));
			i = src.indexOf(`.from(${table})`, i + 1);
		}
		return out;
	};
	it('no query joins answers or participation to anything', () => {
		for (const file of sources) {
			const src = readFileSync(file, 'utf8');
			expect(src, file).not.toMatch(/Join\((surveyAnswers|surveyParticipation)\b/);
			expect(src, file).not.toMatch(/join\s+(public\.)?(survey_answers|survey_participation)\b/i);
			expect(src, file).not.toMatch(/survey_answers[^`]*\bjoin\b/i);
			for (const q of [...queries(src, 'surveyAnswers'), ...queries(src, 'surveyParticipation')])
				expect(q, file).not.toMatch(/Join\(/);
		}
	});
	it('only reads who answered from named surveys', () => {
		for (const file of sources) {
			const src = readFileSync(file, 'utf8');
			for (const q of queries(src, 'surveyAnswers'))
				if (q.includes('surveyAnswers.membershipId') && q.includes('.select('))
					expect(q, file).toContain('eq(surveyAnswers.anonymous, false)');
		}
	});
});
