import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import {
	attendanceDays,
	departments,
	employees,
	leaveRequestDays,
	leaveRequests,
	leaveTypes,
	projects,
	shifts,
	timesheetEntries,
	timesheets
} from '../db/schema';
import { scopeWhere } from '../rbac/scope';
import { add, byDepartment, departmentColumn, personColumns, type Tally } from './groups';
import type { Column, ReportDef, Row, Section } from './types';

const hours = (minutes: number) => Math.round(minutes / 6) / 10;

const ATTENDANCE_COUNTS = [
	['present', 'Present'],
	['late', 'Late'],
	['half_day', 'Half day'],
	['absent', 'Absent'],
	['on_leave', 'On leave'],
	['wfh', 'WFH']
] as const;

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
			tally.workedHours = hours(r.workedMinutes);
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

const WORKING_STATUSES = ['present', 'late', 'half_day', 'absent', 'wfh'];
const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

export const utilisationReport: ReportDef = {
	id: 'utilisation',
	title: 'Utilisation',
	permission: 'report.utilisation',
	async build(tx, { scope, params: { from, to, departmentId } }) {
		const who = and(
			scopeWhere(scope, employees.id),
			departmentId ? eq(employees.departmentId, departmentId) : undefined
		);
		const capacity = await tx
			.select({
				employeeId: employees.id,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				minutes: sql<number>`coalesce(sum(${shifts.fullDayMinutes}), 0)::int`
			})
			.from(attendanceDays)
			.innerJoin(shifts, eq(shifts.id, attendanceDays.shiftId))
			.innerJoin(employees, eq(employees.id, attendanceDays.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.where(
				and(
					who,
					inArray(attendanceDays.status, WORKING_STATUSES),
					gte(attendanceDays.date, from),
					lte(attendanceDays.date, to)
				)
			)
			.groupBy(employees.id, departments.name);
		const logged = await tx
			.select({
				employeeId: employees.id,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				projectId: projects.id,
				project: projects.name,
				projectCode: projects.code,
				client: projects.client,
				billable: projects.billable,
				minutes: sql<number>`sum(${timesheetEntries.minutes})::int`
			})
			.from(timesheetEntries)
			.innerJoin(timesheets, eq(timesheets.id, timesheetEntries.timesheetId))
			.innerJoin(projects, eq(projects.id, timesheetEntries.projectId))
			.innerJoin(employees, eq(employees.id, timesheets.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.where(
				and(
					who,
					eq(timesheets.status, 'approved'),
					gte(timesheetEntries.workDate, from),
					lte(timesheetEntries.workDate, to)
				)
			)
			.groupBy(employees.id, departments.name, projects.id)
			.orderBy(asc(projects.code));
		const keys = ['capacity', 'logged', 'billable'];
		const people = new Map<
			string,
			{ id: string; name: string; code: string; department: string | null; tally: Tally }
		>();
		const personOf = (r: { employeeId: string; name: string; code: string; department: string | null }) => {
			if (!people.has(r.employeeId))
				people.set(r.employeeId, {
					id: r.employeeId,
					name: r.name,
					code: r.code,
					department: r.department,
					tally: { capacity: 0, logged: 0, billable: 0 }
				});
			return people.get(r.employeeId)!;
		};
		for (const c of capacity) personOf(c).tally.capacity = c.minutes;
		const byProject = new Map<
			string,
			{ code: string; project: string; client: string; billable: boolean; people: Set<string>; minutes: number }
		>();
		for (const l of logged) {
			const t = personOf(l).tally;
			t.logged += l.minutes;
			if (l.billable) t.billable += l.minutes;
			if (!byProject.has(l.projectId))
				byProject.set(l.projectId, {
					code: l.projectCode,
					project: l.project,
					client: l.client,
					billable: l.billable,
					people: new Set(),
					minutes: 0
				});
			const p = byProject.get(l.projectId)!;
			p.people.add(l.employeeId);
			p.minutes += l.minutes;
		}
		const list = [...people.values()]
			.sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code))
			.map((p) => ({ ...p, tally: Object.fromEntries(keys.map((k) => [k, hours(p.tally[k])])) }));
		const withRate = (rows: Row[]) =>
			rows.map((r) => ({
				...r,
				cells: { ...r.cells, utilisation: share(Number(r.cells.billable), Number(r.cells.capacity)) }
			}));
		const columns: Column[] = [
			{ key: 'capacity', label: 'Capacity hours', numeric: true },
			{ key: 'logged', label: 'Logged hours', numeric: true },
			{ key: 'billable', label: 'Billable hours', numeric: true },
			{ key: 'utilisation', label: 'Utilisation %', numeric: true }
		];
		return [
			{
				key: 'departments',
				title: 'By department',
				columns: [departmentColumn, ...columns],
				rows: withRate(byDepartment(list, keys))
			},
			{
				key: 'employees',
				title: 'By employee',
				columns: [...personColumns, ...columns],
				rows: withRate(
					list.map((p) => ({
						employeeId: p.id,
						cells: { name: p.name, code: p.code, department: p.department, ...p.tally }
					}))
				)
			},
			{
				key: 'projects',
				title: 'By project',
				columns: [
					{ key: 'code', label: 'Code' },
					{ key: 'project', label: 'Project' },
					{ key: 'client', label: 'Client' },
					{ key: 'billable', label: 'Billable' },
					{ key: 'people', label: 'People', numeric: true },
					{ key: 'hours', label: 'Hours', numeric: true }
				],
				rows: [...byProject.values()].map((p) => ({
					cells: {
						code: p.code,
						project: p.project,
						client: p.client,
						billable: p.billable ? 'Yes' : 'No',
						people: p.people.size,
						hours: hours(p.minutes)
					}
				}))
			}
		];
	}
};
