import { describe, expect, it } from 'vitest';
import { gradeQuiz } from './learning';

describe('gradeQuiz', () => {
	const questions = [
		{ id: 'q1', answerIds: ['a'] },
		{ id: 'q2', answerIds: ['b', 'c'] },
		{ id: 'q3', answerIds: ['d'] }
	];

	it('counts a question right only when the picked set equals the answer set', () => {
		expect(
			gradeQuiz(
				questions,
				new Map([
					['q1', ['a']],
					['q2', ['c', 'b']],
					['q3', ['d']]
				])
			)
		).toBe(100);
		expect(
			gradeQuiz(
				questions,
				new Map([
					['q1', ['a']],
					['q2', ['b']],
					['q3', ['d', 'x']]
				])
			)
		).toBe(33);
		expect(gradeQuiz(questions, new Map([['q2', ['b', 'c', 'x']]]))).toBe(0);
	});

	it('ignores duplicate picks and unknown questions', () => {
		expect(
			gradeQuiz(
				questions,
				new Map([
					['q1', ['a', 'a']],
					['zz', ['a']]
				])
			)
		).toBe(33);
		expect(gradeQuiz(questions, new Map([['q2', ['b', 'b']]]))).toBe(0);
	});

	it('rounds down so a score never reaches a pass mark it did not earn', () => {
		const three = questions.map((q) => ({ ...q, answerIds: ['a'] }));
		expect(
			gradeQuiz(
				three,
				new Map([
					['q1', ['a']],
					['q2', ['a']]
				])
			)
		).toBe(66);
	});

	it('scores an empty quiz as zero', () => {
		expect(gradeQuiz([], new Map())).toBe(0);
	});
});
