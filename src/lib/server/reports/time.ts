import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { attendanceDays, departments, employees, leaveRequestDays, leaveRequests, leaveTypes } from '../db/schema';
import { scopeWhere } from '../rbac/scope';
import type { Column, ReportDef, Row, Section } from './types';

const ATTENDANCE_COUNTS = [
	['present', 'Present'],
	['late', 'Late'],
	['half_day', 'Half day'],
	['absent', 'Absent'],
	['on_leave', 'On leave'],
	['wfh', 'WFH']
] as const;

type Tally = Record<string, number>;

const add = (into: Tally, from: Tally) => {
	for (const [k, v] of Object.entries(from)) into[k] = Math.round(((into[k] ?? 0) + v) * 10) / 10;
};

function byDepartment(people: { department: string | null; tally: Tally }[], keys: string[]): Row[] {
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

const personColumns: Column[] = [
	{ key: 'name', label: 'Name' },
	{ key: 'code', label: 'Code' },
	{ key: 'department', label: 'Department' }
];

export const attendanceReport: ReportDef = {
	id: 'attendance',
	title: 'Attendance',
	permission: 'report.attendance',
	async build(tx, { scope, params: { from, to, departmentId } }) {
		const counts = Object.fromEntries(
			ATTENDANCE_COUNTS.map(([k]) => [k, sql<number>`count(*) filter (where ${attendanceDays.status} = ${k})::int`])
		) as Record<(typeof ATTENDANCE_COUNTS)[number][0], SQL<number>>;
		const rows = await tx
			.select({
				id: employees.id,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				...counts,
				lateMinutes: sql<number>`coalesce(sum(${attendanceDays.lateMinutes}), 0)::int`,
				workedMinutes: sql<number>`coalesce(sum(${attendanceDays.workedMinutes}), 0)::int`
			})
			.from(attendanceDays)
			.innerJoin(employees, eq(employees.id, attendanceDays.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.where(
				and(
					scopeWhere(scope, employees.id),
					departmentId ? eq(employees.departmentId, departmentId) : undefined,
					gte(attendanceDays.date, from),
					lte(attendanceDays.date, to)
				)
			)
			.groupBy(employees.id, departments.name)
			.orderBy(asc(employees.fullName), asc(employees.code));
		const people = rows.map((r) => {
			const tally: Tally = Object.fromEntries(ATTENDANCE_COUNTS.map(([k]) => [k, Number(r[k])]));
			tally.lateMinutes = r.lateMinutes;
			tally.workedHours = Math.round(r.workedMinutes / 6) / 10;
			return { ...r, tally };
		});
		const columns: Column[] = [
			...ATTENDANCE_COUNTS.map(([key, label]) => ({ key, label, numeric: true as const })),
			{ key: 'lateMinutes', label: 'Late minutes', numeric: true },
			{ key: 'workedHours', label: 'Worked hours', numeric: true }
		];
		return [
			{
				key: 'departments',
				title: 'By department',
				columns: [{ key: 'department', label: 'Department' }, ...columns],
				rows: byDepartment(
					people,
					columns.map((c) => c.key)
				)
			},
			{
				key: 'employees',
				title: 'By employee',
				columns: [...personColumns, ...columns],
				rows: people.map((p) => ({
					employeeId: p.id,
					cells: { name: p.name, code: p.code, department: p.department, ...p.tally }
				}))
			}
		];
	}
};

export const leaveReport: ReportDef = {
	id: 'leave',
	title: 'Leave taken',
	permission: 'report.leave',
	async build(tx, { scope, params: { from, to, departmentId } }) {
		const rows = await tx
			.select({
				id: employees.id,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				typeId: leaveTypes.id,
				typeName: leaveTypes.name,
				days: sql<string>`sum(case when ${leaveRequestDays.session} = 'full' then 1 else 0.5 end)`
			})
			.from(leaveRequestDays)
			.innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
			.innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
			.innerJoin(employees, eq(employees.id, leaveRequestDays.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.where(
				and(
					scopeWhere(scope, employees.id),
					departmentId ? eq(employees.departmentId, departmentId) : undefined,
					eq(leaveRequestDays.status, 'approved'),
					gte(leaveRequestDays.date, from),
					lte(leaveRequestDays.date, to)
				)
			)
			.groupBy(employees.id, departments.name, leaveTypes.id)
			.orderBy(asc(employees.fullName), asc(employees.code));
		const types = [...new Map(rows.map((r) => [r.typeId, r.typeName]))]
			.sort(([, a], [, b]) => a.localeCompare(b))
			.map(([id, name]) => ({ key: `type_${id}`, label: name, numeric: true as const }));
		const keys = [...types.map((t) => t.key), 'total'];
		const people = [...Map.groupBy(rows, (r) => r.id).values()].map((own) => {
			const tally: Tally = Object.fromEntries(keys.map((k) => [k, 0]));
			for (const r of own) add(tally, { [`type_${r.typeId}`]: Number(r.days), total: Number(r.days) });
			return { ...own[0], tally };
		});
		const columns: Column[] = [...types, { key: 'total', label: 'Total days', numeric: true }];
		const sections: Section[] = [
			{
				key: 'departments',
				title: 'By department',
				columns: [{ key: 'department', label: 'Department' }, ...columns],
				rows: byDepartment(people, keys)
			},
			{
				key: 'employees',
				title: 'By employee',
				columns: [...personColumns, ...columns],
				rows: people.map((p) => ({
					employeeId: p.id,
					cells: { name: p.name, code: p.code, department: p.department, ...p.tally }
				}))
			}
		];
		return sections;
	}
};
