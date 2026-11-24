import { taka } from '../../money';
import type { Column, Row } from './types';

export type Tally = Record<string, number>;

export const add = (into: Tally, from: Tally) => {
	for (const [k, v] of Object.entries(from)) into[k] = Math.round(((into[k] ?? 0) + v) * 10) / 10;
};

export function byDepartment(people: { department: string | null; tally: Tally }[], keys: string[]): Row[] {
	const zero = () => Object.fromEntries(keys.map((k) => [k, 0]));
	const groups = new Map<string, Tally>();
	const total = zero();
	for (const p of people) {
		const name = p.department ?? 'No department';
		const g = groups.get(name) ?? zero();
		groups.set(name, g);
		add(g, p.tally);
		add(total, p.tally);
	}
	return [
		...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([department, t]) => ({ cells: { department, ...t } })),
		{ cells: { department: 'All departments', ...total } }
	];
}

export const personColumns: Column[] = [
	{ key: 'name', label: 'Name' },
	{ key: 'code', label: 'Code' },
	{ key: 'department', label: 'Department' }
];

export const departmentColumn: Column = { key: 'department', label: 'Department' };

export const amount = (key: string, label: string): Column => ({ key, label, numeric: true });

export const inTaka = (rows: Row[], keys: string[]): Row[] =>
	rows.map((r) => ({
		...r,
		cells: { ...r.cells, ...Object.fromEntries(keys.map((k) => [k, taka(Number(r.cells[k] ?? 0))])) }
	}));
