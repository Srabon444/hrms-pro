import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
	candidateStageHistory,
	candidates,
	departments,
	designations,
	employees,
	interviews,
	jobOpenings,
	offers,
	pipelineStages,
	tenantSettings
} from '../db/schema';
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

const FUNNEL = [
	['applied', 'Applied'],
	['interviewed', 'Interviewed'],
	['offered', 'Offered'],
	['accepted', 'Accepted'],
	['hired', 'Hired'],
	['rejected', 'Rejected']
] as const;

export const recruitmentReport: ReportDef = {
	id: 'recruitment',
	title: 'Recruitment funnel',
	permission: 'report.recruitment',
	async build(tx, { scope, params: { from, to, departmentId } }) {
		const [settings] = await tx.select({ tz: tenantSettings.timezone }).from(tenantSettings);
		const within = (col: string) =>
			sql`(${sql.raw(col)} at time zone ${settings?.tz ?? 'UTC'})::date between ${from}::date and ${to}::date`;
		const moved = (kind: 'hired' | 'rejected') =>
			sql<number>`(select count(distinct h.candidate_id)::int from ${candidateStageHistory} h join ${pipelineStages} s on s.id = h.to_stage_id and s.tenant_id = h.tenant_id where h.candidate_id in (select c.id from ${candidates} c where c.opening_id = ${jobOpenings.id}) and s.kind = ${kind} and ${within('h.created_at')})`;
		const openings = await tx
			.select({
				id: jobOpenings.id,
				title: jobOpenings.title,
				department: departments.name,
				status: jobOpenings.status,
				applied: sql<number>`(select count(*)::int from ${candidates} c where c.opening_id = ${jobOpenings.id} and ${within('c.created_at')})`,
				interviewed: sql<number>`(select count(distinct i.candidate_id)::int from ${interviews} i join ${candidates} c on c.id = i.candidate_id where c.opening_id = ${jobOpenings.id} and i.status = 'scheduled' and ${within('i.scheduled_at')})`,
				offered: sql<number>`(select count(*)::int from ${offers} o join ${candidates} c on c.id = o.candidate_id where c.opening_id = ${jobOpenings.id} and ${within('o.created_at')})`,
				accepted: sql<number>`(select count(*)::int from ${offers} o join ${candidates} c on c.id = o.candidate_id where c.opening_id = ${jobOpenings.id} and o.status = 'accepted' and ${within('o.decided_at')})`,
				hired: moved('hired'),
				rejected: moved('rejected')
			})
			.from(jobOpenings)
			.leftJoin(departments, eq(departments.id, jobOpenings.departmentId))
			.where(
				and(
					departmentId ? eq(jobOpenings.departmentId, departmentId) : undefined,
					scope.kind === 'all'
						? undefined
						: inArray(
								jobOpenings.departmentId,
								tx.select({ id: employees.departmentId }).from(employees).where(scopeWhere(scope, employees.id))
							)
				)
			)
			.orderBy(asc(jobOpenings.title));
		const active = openings.filter((o) => o.status !== 'closed' || FUNNEL.some(([k]) => o[k] > 0));
		const total = Object.fromEntries(FUNNEL.map(([k]) => [k, active.reduce((n, o) => n + o[k], 0)]));
		return [
			{
				key: 'openings',
				title: 'By opening',
				columns: [
					{ key: 'opening', label: 'Opening' },
					{ key: 'department', label: 'Department' },
					{ key: 'status', label: 'Status' },
					...FUNNEL.map(([key, label]) => ({ key, label, numeric: true as const }))
				],
				rows: [
					...active.map((o) => ({
						cells: {
							opening: o.title,
							department: o.department,
							status: o.status,
							...Object.fromEntries(FUNNEL.map(([k]) => [k, o[k]]))
						}
					})),
					{ cells: { opening: 'All openings', department: null, status: null, ...total } }
				]
			}
		];
	}
};
