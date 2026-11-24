import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { taka } from '../../money';
import { departments, employees, payrollRuns, payslips } from '../db/schema';
import { scopeWhere } from '../rbac/scope';
import type { Cell, Column, ReportDef, Row, Section } from './types';

export const MIN_PAYROLL_GROUP = 5;

const AMOUNTS = [
	['gross', 'Gross'],
	['deductions', 'Deductions'],
	['tax', 'Tax'],
	['net', 'Net']
] as const;

type Amounts = Record<(typeof AMOUNTS)[number][0], number>;
type Group = Amounts & { people: Set<string> };

const amountColumns: Column[] = [
	{ key: 'employees', label: 'Employees', numeric: true },
	...AMOUNTS.map(([key, label]) => ({ key, label, numeric: true as const }))
];

const newGroup = (): Group => ({ gross: 0, deductions: 0, tax: 0, net: 0, people: new Set() });

function totals(g: Group, open: boolean): Record<string, Cell> {
	if (!open && g.people.size < MIN_PAYROLL_GROUP)
		return { employees: `<${MIN_PAYROLL_GROUP}`, gross: null, deductions: null, tax: null, net: null };
	return { employees: g.people.size, ...Object.fromEntries(AMOUNTS.map(([k]) => [k, taka(g[k])])) };
}

function groupOf<G>(groups: Map<string, G>, key: string, make: () => G) {
	if (!groups.has(key)) groups.set(key, make());
	return groups.get(key)!;
}

export const payrollCostReport: ReportDef = {
	id: 'payroll',
	title: 'Payroll cost',
	permission: 'report.payroll',
	sensitive: true,
	async build(tx, { scope, params: { from, to, departmentId } }) {
		const slips = await tx
			.select({
				employeeId: payslips.employeeId,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				period: payrollRuns.period,
				gross: payslips.gross,
				deductions: payslips.deductions,
				tax: payslips.tax,
				net: payslips.net
			})
			.from(payslips)
			.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
			.innerJoin(employees, eq(employees.id, payslips.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.where(
				and(
					scopeWhere(scope, employees.id),
					departmentId ? eq(employees.departmentId, departmentId) : undefined,
					inArray(payrollRuns.status, ['approved', 'paid']),
					gte(payrollRuns.period, from.slice(0, 7)),
					lte(payrollRuns.period, to.slice(0, 7)),
					isNull(payslips.error)
				)
			)
			.orderBy(asc(employees.fullName), asc(employees.code), asc(payrollRuns.period));
		const open = scope.kind === 'all';
		const byDepartment = new Map<string, Group>();
		const byMonth = new Map<string, Group>();
		const byEmployee = new Map<string, Group & { name: string; code: string; department: string | null }>();
		const all = newGroup();
		for (const s of slips) {
			const person = () => ({ ...newGroup(), name: s.name, code: s.code, department: s.department });
			for (const g of [
				groupOf(byDepartment, s.department ?? 'No department', newGroup),
				groupOf(byMonth, s.period, newGroup),
				groupOf(byEmployee, s.employeeId, person),
				all
			]) {
				for (const [k] of AMOUNTS) g[k] += s[k];
				g.people.add(s.employeeId);
			}
		}
		const sorted = (m: Map<string, Group>) => [...m].sort(([a], [b]) => a.localeCompare(b));
		const sections: Section[] = [
			{
				key: 'departments',
				title: 'By department',
				columns: [{ key: 'department', label: 'Department' }, ...amountColumns],
				rows: [
					...sorted(byDepartment).map(([department, g]) => ({ cells: { department, ...totals(g, open) } })),
					{ cells: { department: 'All departments', ...totals(all, open) } }
				]
			},
			{
				key: 'months',
				title: 'By month',
				columns: [{ key: 'month', label: 'Month' }, ...amountColumns],
				rows: sorted(byMonth).map(([month, g]) => ({ cells: { month, ...totals(g, open) } }))
			}
		];
		if (open)
			sections.push({
				key: 'employees',
				title: 'By employee',
				columns: [
					{ key: 'name', label: 'Name' },
					{ key: 'code', label: 'Code' },
					{ key: 'department', label: 'Department' },
					...AMOUNTS.map(([key, label]) => ({ key, label, numeric: true as const }))
				],
				rows: [...byEmployee].map(([employeeId, g]): Row => ({
					employeeId,
					cells: {
						name: g.name,
						code: g.code,
						department: g.department,
						...Object.fromEntries(AMOUNTS.map(([k]) => [k, taka(g[k])]))
					}
				}))
			});
		return sections;
	}
};
