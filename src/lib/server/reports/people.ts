import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { departments, designations, employees } from '../db/schema';
import { scopeWhere } from '../rbac/scope';
import type { ReportDef } from './types';

const rate = (leavers: number, start: number, end: number) =>
	start + end ? Math.round((leavers / ((start + end) / 2)) * 1000) / 10 : null;

export const headcountReport: ReportDef = {
	id: 'headcount',
	title: 'Headcount and attrition',
	permission: 'report.headcount',
	async build(tx, { scope, params: { from, to, departmentId } }) {
		const people = await tx
			.select({
				id: employees.id,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				designation: designations.name,
				joinDate: employees.joinDate,
				exitDate: employees.exitDate
			})
			.from(employees)
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.leftJoin(designations, eq(designations.id, employees.designationId))
			.where(
				and(
					scopeWhere(scope, employees.id),
					departmentId ? eq(employees.departmentId, departmentId) : undefined,
					lte(employees.joinDate, to),
					or(isNull(employees.exitDate), gte(employees.exitDate, from))
				)
			)
			.orderBy(asc(employees.fullName), asc(employees.code));
		const joiners = people.filter((p) => p.joinDate >= from);
		const leavers = people.filter((p) => p.exitDate && p.exitDate <= to);
		const groups = new Map<string, { start: number; joiners: number; leavers: number; end: number }>();
		const total = { start: 0, joiners: 0, leavers: 0, end: 0 };
		for (const p of people) {
			const name = p.department ?? 'No department';
			const g = groups.get(name) ?? { start: 0, joiners: 0, leavers: 0, end: 0 };
			groups.set(name, g);
			for (const t of [g, total]) {
				if (p.joinDate < from) t.start++;
				else t.joiners++;
				if (p.exitDate && p.exitDate <= to) t.leavers++;
				else t.end++;
			}
		}
		const line = (department: string, t: typeof total) => ({
			cells: { department, ...t, attrition: rate(t.leavers, t.start, t.end) }
		});
		return [
			{
				key: 'departments',
				title: 'By department',
				columns: [
					{ key: 'department', label: 'Department' },
					{ key: 'start', label: `On ${from}`, numeric: true },
					{ key: 'joiners', label: 'Joined', numeric: true },
					{ key: 'leavers', label: 'Left', numeric: true },
					{ key: 'end', label: `After ${to}`, numeric: true },
					{ key: 'attrition', label: 'Attrition %', numeric: true }
				],
				rows: [
					...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, g]) => line(name, g)),
					line('All departments', total)
				]
			},
			{
				key: 'joiners',
				title: 'Joiners',
				columns: [
					{ key: 'name', label: 'Name' },
					{ key: 'code', label: 'Code' },
					{ key: 'department', label: 'Department' },
					{ key: 'designation', label: 'Designation' },
					{ key: 'joined', label: 'Joined' }
				],
				rows: joiners.map((p) => ({
					employeeId: p.id,
					cells: {
						name: p.name,
						code: p.code,
						department: p.department,
						designation: p.designation,
						joined: p.joinDate
					}
				}))
			},
			{
				key: 'leavers',
				title: 'Leavers',
				columns: [
					{ key: 'name', label: 'Name' },
					{ key: 'code', label: 'Code' },
					{ key: 'department', label: 'Department' },
					{ key: 'lastDay', label: 'Last day' }
				],
				rows: leavers.map((p) => ({
					employeeId: p.id,
					cells: { name: p.name, code: p.code, department: p.department, lastDay: p.exitDate }
				}))
			}
		];
	}
};
