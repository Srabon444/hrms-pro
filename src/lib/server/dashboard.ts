import { and, asc, desc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { money } from '../money';
import { announcementFeed } from './announcements';
import { pendingApprovals } from './approvals';
import { todayPunches } from './attendance';
import { addDays } from './dates';
import { weekCelebrations } from './directory';
import { employeeDocuments, employees, payrollRuns, payslips } from './db/schema';
import { ownBalances } from './leave';
import { whoIsOut } from './leave-requests';
import { probationDue, tenantToday } from './lifecycle';
import { myMeals } from './meal-orders';
import { canSeePayroll } from './payroll';
import { can, userCtx, type Access, type requireMember } from './rbac/access';
import { resolveScope, scopeWhere } from './rbac/scope';
import { headcountReport } from './reports/people';
import { readSettings } from './settings';
import { withTenant, type Tx } from './tenancy';

export const DASHBOARD_LIST_SIZE = 5;

async function headcount(tx: Tx, access: Access, today: string) {
	const from = `${today.slice(0, 8)}01`;
	const sections = await headcountReport.build(tx, {
		scope: await resolveScope(tx, access, 'report.headcount'),
		params: { from, to: today, departmentId: null, departmentName: null },
		access
	});
	const all = sections.find((s) => s.key === 'departments')!.rows.at(-1)!.cells;
	return {
		from,
		start: Number(all.start),
		joiners: Number(all.joiners),
		leavers: Number(all.leavers),
		end: Number(all.end),
		attrition: all.attrition
	};
}

async function expiringDocuments(tx: Tx, access: Access, today: string) {
	const days = (await readSettings(tx)).documentExpiryAlertDays;
	const rows = await tx
		.select({
			id: employeeDocuments.id,
			employeeId: employees.id,
			name: employees.fullName,
			title: employeeDocuments.title,
			expiresOn: employeeDocuments.expiresOn
		})
		.from(employeeDocuments)
		.innerJoin(employees, eq(employees.id, employeeDocuments.employeeId))
		.where(
			and(
				scopeWhere(await resolveScope(tx, access, 'document.read'), employees.id),
				ne(employees.status, 'exited'),
				gte(employeeDocuments.expiresOn, addDays(today, -days)),
				lte(employeeDocuments.expiresOn, addDays(today, days))
			)
		)
		.orderBy(asc(employeeDocuments.expiresOn), asc(employees.fullName))
		.limit(DASHBOARD_LIST_SIZE);
	return rows.map((r) => ({ ...r, expired: r.expiresOn! < today }));
}

async function lastRun(tx: Tx) {
	const [run] = await tx
		.select({
			id: payrollRuns.id,
			period: payrollRuns.period,
			title: payrollRuns.title,
			runType: payrollRuns.runType,
			status: payrollRuns.status,
			currency: payrollRuns.currency,
			employees: sql<number>`count(${payslips.id}) filter (where ${payslips.error} is null)::int`,
			gross: sql<number>`coalesce(sum(${payslips.gross}) filter (where ${payslips.error} is null), 0)::bigint`,
			net: sql<number>`coalesce(sum(${payslips.net}) filter (where ${payslips.error} is null), 0)::bigint`
		})
		.from(payrollRuns)
		.leftJoin(payslips, eq(payslips.runId, payrollRuns.id))
		.where(ne(payrollRuns.status, 'void'))
		.groupBy(payrollRuns.id)
		.orderBy(desc(payrollRuns.period), desc(payrollRuns.createdAt))
		.limit(1);
	const currency = run?.currency ?? 'BDT';
	return run ? { ...run, gross: money(Number(run.gross), currency), net: money(Number(run.net), currency) } : null;
}

export async function homeDashboard(m: ReturnType<typeof requireMember>) {
	const a = m.access;
	const payroll = canSeePayroll(a);
	return withTenant(userCtx(m, { salaryAll: can(a, 'salary.approve'), payrollAll: payroll }), async (tx) => {
		const today = await tenantToday(tx);
		const approvals = await pendingApprovals(tx, a);
		return {
			today,
			announcements: await announcementFeed(tx, a, DASHBOARD_LIST_SIZE),
			approvals: { count: approvals.length, items: approvals.slice(0, DASHBOARD_LIST_SIZE) },
			leave: a.employeeId && can(a, 'leave.request') ? (await ownBalances(tx, a)).rows : null,
			attendance: can(a, 'attendance.punch') ? await todayPunches(tx, a) : null,
			meals: can(a, 'meal.order') ? ((await myMeals(tx, a))?.days[0] ?? null) : null,
			out: can(a, 'leave.approve') ? await whoIsOut(tx, a, today, today) : null,
			headcount: can(a, 'report.headcount') ? await headcount(tx, a, today) : null,
			probation: can(a, 'employee.update') ? (await probationDue(tx, a)).rows.slice(0, DASHBOARD_LIST_SIZE) : null,
			documents: await expiringDocuments(tx, a, today),
			payroll: payroll ? await lastRun(tx) : null,
			celebrations: can(a, 'directory.read') ? await weekCelebrations(tx, today) : null
		};
	});
}
