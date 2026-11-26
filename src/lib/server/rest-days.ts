import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { tenantSettings, workWeekAssignments, workWeeks } from './db/schema';
import type { Tx } from './tenancy';

export type WeekRow = { employeeId: string; effectiveFrom: string; weekendDays: number[] };
export type RestDay = (employeeId: string, date: string) => boolean;

const weekday = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

export function restDays(tenantWeekend: readonly number[], rows: readonly WeekRow[]): RestDay {
	const newestFirst = [...rows].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
	const byEmployee = Map.groupBy(newestFirst, (r) => r.employeeId);
	return (employeeId, date) =>
		(byEmployee.get(employeeId)?.find((r) => r.effectiveFrom <= date)?.weekendDays ?? tenantWeekend).includes(
			weekday(date)
		);
}

export async function tenantWeekend(tx: Tx): Promise<number[]> {
	const [s] = await tx.select({ days: tenantSettings.weekendDays }).from(tenantSettings);
	return s?.days ?? [5, 6];
}

export async function workWeekRows(tx: Tx, employeeIds: string[] | undefined, to: string): Promise<WeekRow[]> {
	if (employeeIds && !employeeIds.length) return [];
	return tx
		.select({
			employeeId: workWeekAssignments.employeeId,
			effectiveFrom: workWeekAssignments.effectiveFrom,
			weekendDays: workWeeks.weekendDays
		})
		.from(workWeekAssignments)
		.innerJoin(workWeeks, eq(workWeeks.id, workWeekAssignments.workWeekId))
		.where(
			and(
				lte(workWeekAssignments.effectiveFrom, to),
				employeeIds ? inArray(workWeekAssignments.employeeId, employeeIds) : undefined
			)
		)
		.orderBy(desc(workWeekAssignments.effectiveFrom));
}

export async function restDayResolver(tx: Tx, employeeIds: string[] | undefined, to: string): Promise<RestDay> {
	const [weekend, rows] = await Promise.all([tenantWeekend(tx), workWeekRows(tx, employeeIds, to)]);
	return restDays(weekend, rows);
}
