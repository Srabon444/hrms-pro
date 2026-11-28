import { describe, expect, it } from 'vitest';
import { slugOf } from '../recruitment';
import { pdfName } from './careers';

describe('careers links and CV names', () => {
	it.each([
		['Data Analyst!', 'data-analyst'],
		['  Senior   C++ / Go dev  ', 'senior-c-go-dev'],
		['Café manager', 'cafe-manager'],
		['Résumé reviewer', 'resume-reviewer'],
		['★★', 'job'],
		['a'.repeat(62) + ' b', 'a'.repeat(62)]
	])('makes %s into %s', (title, slug) => {
		expect(slugOf(title)).toBe(slug);
		expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
	});

	it.each([
		['cv.pdf', 'cv.pdf'],
		['CV.PDF', 'CV.PDF'],
		['../\u202ecv.exe', 'cv.exe.pdf'],
		['C:\\x\\resume', 'resume.pdf'],
		['', 'file.pdf'],
		['x'.repeat(300) + '.pdf', 'x'.repeat(196) + '.pdf']
	])('stores %s as %s', (name, stored) => {
		expect(pdfName(name)).toBe(stored);
	});
});
