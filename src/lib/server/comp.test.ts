import { expect, it } from 'vitest';
import { raiseSalary } from './comp';

const c = (id: string, code: string, kind: string, calc: string) =>
	({ id, code, kind, calc, name: code, active: true, system: false }) as never;
const components = [
	c('b', 'BASIC', 'earning', 'fixed'),
	c('h', 'HOUSE_RENT', 'earning', 'pct_basic'),
	c('m', 'MEDICAL', 'earning', 'fixed'),
	c('p', 'PF', 'deduction', 'pct_basic'),
	c('u', 'UNION', 'deduction', 'fixed')
];
const line = (componentId: string, value: number, amount = value) => ({ componentId, value, amount });

it('scales basic and fixed earnings, keeps percentages and fixed deductions', () => {
	const current = [
		line('b', 2_000_000),
		line('h', 5000, 1_000_000),
		line('m', 100_000),
		line('p', 1000, 200_000),
		line('u', 5000)
	];
	expect(raiseSalary(components, 3_100_000, current, 1000)).toEqual({
		lines: [
			{ componentId: 'b', value: 2_200_000, amount: 2_200_000 },
			{ componentId: 'h', value: 5000, amount: 1_100_000 },
			{ componentId: 'm', value: 110_000, amount: 110_000 },
			{ componentId: 'p', value: 1000, amount: 220_000 },
			{ componentId: 'u', value: 5000, amount: 5000 }
		],
		gross: 3_410_000
	});
});

it('lands within a minor unit of the target when rounding cannot be exact', () => {
	const current = [line('b', 1_234_567), line('h', 3333, 411_481), line('m', 33_333)];
	const { gross } = raiseSalary(components, 1_679_381, current, 777);
	expect(Math.abs(gross - Math.round(1_679_381 * 1.0777))).toBeLessThanOrEqual(1);
});

it('refuses a salary that uses a component no longer active', () => {
	expect(() => raiseSalary(components.slice(0, 2), 2_000_000, [line('b', 1_500_000), line('m', 500_000)], 500)).toThrow(
		'A pay component in this salary is no longer active.'
	);
});

it('refuses a raise that would not fit in a salary', () => {
	expect(() => raiseSalary(components, 2_000_000_000, [line('b', 2_000_000_000)], 10_000)).toThrow(
		'The new salary is too large.'
	);
});
