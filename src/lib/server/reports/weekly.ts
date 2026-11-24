import { and, asc, eq, gte, inArray, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import {
	attendanceDays,
	departments,
	designations,
	employees,
	shifts,
	ticketCategories,
	tickets,
	workPlanItems
} from '../db/schema';
import { addDays } from '../dates';
import { tenantToday, tenantWeeks } from '../lifecycle';
import { can } from '../rbac/access';
import { resolveScope, scopeWhere } from '../rbac/scope';
import { readSettings } from '../settings';
import { personColumns } from './groups';
import { recruitmentReport } from './people';
import { attendanceReport } from './time';
import type { ReportDef, Section } from './types';

const hours = (minutes: number) => Math.round(minutes / 6) / 10;

export const weeklyReport: ReportDef = {
	id: 'weekly',
	title: 'Weekly management report',
	permission: 'report.weekly',
	defaultPeriod: 'week',
	sectionPermissions: { recruitment: 'report.recruitment' },
	async build(tx, input) {
		const {
			scope,
			params: { from, to, departmentId }
		} = input;
		const inScope = and(
			scopeWhere(scope, employees.id),
			departmentId ? eq(employees.departmentId, departmentId) : undefined
		);
		const pick = (sections: Section[], key: string, as: string, title: string) => ({
			...sections.find((s) => s.key === key)!,
			key: as,
			title
		});
		const today = await tenantToday(tx);
		const short = await tx
			.select({
				id: employees.id,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				date: attendanceDays.date,
				worked: attendanceDays.workedMinutes,
				required: shifts.fullDayMinutes
			})
			.from(attendanceDays)
			.innerJoin(shifts, eq(shifts.id, attendanceDays.shiftId))
			.innerJoin(employees, eq(employees.id, attendanceDays.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.where(
				and(
					inScope,
					inArray(attendanceDays.status, ['present', 'late', 'wfh']),
					sql`${attendanceDays.workedMinutes} < ${shifts.fullDayMinutes}`,
					gte(attendanceDays.date, from),
					lte(attendanceDays.date, to),
					lt(attendanceDays.date, today)
				)
			)
			.orderBy(asc(attendanceDays.date), asc(employees.fullName));
		const hires = await tx
			.select({
				id: employees.id,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				designation: designations.name,
				joinDate: employees.joinDate
			})
			.from(employees)
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.leftJoin(designations, eq(designations.id, employees.designationId))
			.where(
				and(
					inScope,
					gte(employees.joinDate, from),
					lte(employees.joinDate, addDays(to, (await readSettings(tx)).upcomingHireDays))
				)
			)
			.orderBy(asc(employees.joinDate), asc(employees.fullName));
		const issues = await tx
			.select({
				id: employees.id,
				number: tickets.number,
				subject: tickets.subject,
				category: ticketCategories.name,
				requester: employees.fullName,
				priority: tickets.priority,
				status: tickets.status,
				assignee: sql<
					string | null
				>`(select tu.name from tenant_users tu where tu.membership_id = ${tickets.assigneeMembershipId})`
			})
			.from(tickets)
			.innerJoin(ticketCategories, eq(ticketCategories.id, tickets.categoryId))
			.innerJoin(employees, eq(employees.id, tickets.requesterEmployeeId))
			.where(
				and(
					inScope,
					eq(ticketCategories.confidential, false),
					sql`${tickets.createdAt} < (${addDays(to, 1)}::date)::timestamp at time zone (select timezone from tenant_settings)`,
					or(
						notInArray(tickets.status, ['resolved', 'closed']),
						sql`${tickets.createdAt} >= (${from}::date)::timestamp at time zone (select timezone from tenant_settings)`
					)
				)
			)
			.orderBy(asc(tickets.number));
		const weeks = await tenantWeeks(tx);
		const plan = await tx
			.select({
				id: employees.id,
				name: employees.fullName,
				week: workPlanItems.weekStart,
				item: workPlanItems.description,
				target: workPlanItems.target,
				status: workPlanItems.status
			})
			.from(workPlanItems)
			.innerJoin(employees, eq(employees.id, workPlanItems.employeeId))
			.where(
				and(
					inScope,
					gte(workPlanItems.weekStart, weeks.of(from)),
					lte(workPlanItems.weekStart, addDays(weeks.of(to), 7))
				)
			)
			.orderBy(asc(workPlanItems.weekStart), asc(employees.fullName), asc(workPlanItems.createdAt));
		const recruitment = can(input.access, weeklyReport.sectionPermissions!.recruitment)
			? [
					pick(
						await recruitmentReport.build(tx, {
							...input,
							scope: await resolveScope(tx, input.access, weeklyReport.sectionPermissions!.recruitment)
						}),
						'openings',
						'recruitment',
						'Recruitment'
					)
				]
			: [];
		return [
			pick(await attendanceReport.build(tx, input), 'departments', 'attendance', 'Attendance'),
			{
				key: 'short_hours',
				title: 'Days short of full hours',
				columns: [
					...personColumns,
					{ key: 'date', label: 'Date' },
					{ key: 'worked', label: 'Worked hours', numeric: true },
					{ key: 'required', label: 'Required hours', numeric: true }
				],
				rows: short.map((s) => ({
					employeeId: s.id,
					cells: {
						name: s.name,
						code: s.code,
						department: s.department,
						date: s.date,
						worked: hours(s.worked),
						required: hours(s.required)
					}
				}))
			},
			...recruitment,
			{
				key: 'new_hires',
				title: 'New and upcoming hires',
				columns: [...personColumns, { key: 'designation', label: 'Designation' }, { key: 'joins', label: 'Joins' }],
				rows: hires.map((h) => ({
					employeeId: h.id,
					cells: {
						name: h.name,
						code: h.code,
						department: h.department,
						designation: h.designation,
						joins: h.joinDate
					}
				}))
			},
			{
				key: 'issues',
				title: 'Helpdesk issues',
				columns: [
					{ key: 'number', label: 'Ticket' },
					{ key: 'subject', label: 'Subject' },
					{ key: 'category', label: 'Category' },
					{ key: 'requester', label: 'Requester' },
					{ key: 'priority', label: 'Priority' },
					{ key: 'status', label: 'Status' },
					{ key: 'assignee', label: 'Assignee' }
				],
				rows: issues.map(({ id, number, ...rest }) => ({
					employeeId: id,
					cells: { number: `#${number}`, ...rest }
				}))
			},
			{
				key: 'plan',
				title: 'Work plan',
				columns: [
					{ key: 'week', label: 'Week of' },
					{ key: 'name', label: 'Name' },
					{ key: 'item', label: 'Item' },
					{ key: 'target', label: 'Target' },
					{ key: 'status', label: 'Status' }
				],
				rows: plan.map(({ id, ...cells }) => ({ employeeId: id, cells }))
			}
		];
	}
};
