import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { departments } from '../db/schema';
import { AppError } from '../errors';
import { tenantToday, tenantWeeks } from '../lifecycle';
import { can, userCtx, type Access, type requireMember } from '../rbac/access';
import { resolveScope } from '../rbac/scope';
import type { Tx } from '../tenancy';
import { expenseReport, mealReport, payrollCostReport } from './money';
import { headcountReport, recruitmentReport } from './people';
import { attendanceReport, leaveReport, utilisationReport } from './time';
import { weeklyReport } from './weekly';
import type { Report, ReportDef, ReportParams } from './types';

export const REPORTS: ReportDef[] = [
	headcountReport,
	attendanceReport,
	leaveReport,
	payrollCostReport,
	mealReport,
	expenseReport,
	recruitmentReport,
	utilisationReport,
	weeklyReport
];

export const MAX_REPORT_DAYS = 366;

export function reportCtx(m: ReturnType<typeof requireMember>, id: string) {
	const def = REPORTS.find((r) => r.id === id);
	return userCtx(m, { payrollAll: !!def?.sensitive && can(m.access, def.permission) });
}

export const reportsFor = (access: Access) =>
	REPORTS.filter((r) => can(access, r.permission)).map((r) => ({ id: r.id, title: r.title }));

export function reportDef(access: Access, id: string): ReportDef {
	const def = REPORTS.find((r) => r.id === id);
	if (!def || !can(access, def.permission)) throw new AppError('not_found', 'That report does not exist.', 404);
	return def;
}

const blank = (v: unknown) => (v === '' ? undefined : v);
const paramsSchema = z.object({
	from: z.preprocess(blank, z.iso.date('Enter the start as a date.').optional()),
	to: z.preprocess(blank, z.iso.date('Enter the end as a date.').optional()),
	department: z.preprocess(blank, z.uuid('Choose a department from the list.').optional())
});

const spanDays = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;

export async function reportParams(tx: Tx, raw: Record<string, string>, period?: 'week'): Promise<ReportParams> {
	const p = paramsSchema.parse(raw);
	const to = p.to ?? (await tenantToday(tx));
	const from = p.from ?? (period === 'week' ? (await tenantWeeks(tx)).of(to) : `${to.slice(0, 8)}01`);
	if (from > to) throw new AppError('bad_range', 'The start date must be on or before the end date.', 400);
	if (spanDays(from, to) > MAX_REPORT_DAYS)
		throw new AppError('bad_range', `Choose a period of at most ${MAX_REPORT_DAYS} days.`, 400);
	if (!p.department) return { from, to, departmentId: null, departmentName: null };
	const [d] = await tx.select().from(departments).where(eq(departments.id, p.department));
	if (!d) throw new AppError('not_found', 'That department does not exist.', 404);
	return { from, to, departmentId: d.id, departmentName: d.name };
}

export async function runReport(tx: Tx, access: Access, id: string, raw: Record<string, string>): Promise<Report> {
	const def = reportDef(access, id);
	const params = await reportParams(tx, raw, def.defaultPeriod);
	const scope = await resolveScope(tx, access, def.permission);
	return { id: def.id, title: def.title, params, sections: await def.build(tx, { scope, params, access }) };
}

export const departmentOptions = (tx: Tx) =>
	tx.select({ id: departments.id, name: departments.name }).from(departments).orderBy(asc(departments.name));
