import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { rosterEntries, shiftAssignments, shifts, tenantSettings, workWeekAssignments, workWeeks } from './db/schema';
import type { Tx } from './tenancy';

type Shift = typeof shifts.$inferSelect;
export type WeekRow = { employeeId: string; effectiveFrom: string; weekendDays: number[]; rosterMode?: boolean };
export type RestDay = (employeeId: string, date: string) => boolean;
export type Rostered = 'work' | 'off' | null;
export type DayRule = { shift: Shift | undefined; rostered: Rostered; rest: boolean; rosterRest: boolean };
type Entry = { employeeId: string; date: string; kind: string; shiftId: string | null };
type Assignment = { employeeId: string; effectiveFrom: string; shiftId: string };

const weekday = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

const latestFirst = <T extends { employeeId: string; effectiveFrom: string }>(rows: readonly T[]) =>
	Map.groupBy(
		[...rows].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)),
		(r) => r.employeeId
	);

function weekOn(tenantWeekend: readonly number[], rows: readonly WeekRow[]) {
	const byEmployee = latestFirst(rows);
	return (employeeId: string, date: string) =>
		byEmployee.get(employeeId)?.find((r) => r.effectiveFrom <= date) ?? {
			weekendDays: tenantWeekend,
			rosterMode: false
		};
}

export function restDays(tenantWeekend: readonly number[], rows: readonly WeekRow[]): RestDay {
	const week = weekOn(tenantWeekend, rows);
	return (employeeId, date) => week(employeeId, date).weekendDays.includes(weekday(date));
}

export function dayRule(
	tenantWeekend: readonly number[],
	weeks: readonly WeekRow[],
	allShifts: readonly Shift[],
	assignments: readonly Assignment[],
	entries: readonly Entry[]
) {
	const week = weekOn(tenantWeekend, weeks);
	const byId = new Map(allShifts.map((s) => [s.id, s]));
	const fallback = allShifts.find((s) => s.isDefault);
	const assigned = latestFirst(assignments);
	const rostered = new Map(entries.map((e) => [`${e.employeeId}:${e.date}`, e]));
	return (employeeId: string, date: string): DayRule => {
		const a = assigned.get(employeeId)?.find((x) => x.effectiveFrom <= date);
		const underlying = a ? byId.get(a.shiftId) : fallback;
		const entry = rostered.get(`${employeeId}:${date}`);
		const w = week(employeeId, date);
		if (entry?.kind === 'work')
			return { shift: byId.get(entry.shiftId!) ?? underlying, rostered: 'work', rest: false, rosterRest: false };
		if (entry?.kind === 'off') return { shift: underlying, rostered: 'off', rest: true, rosterRest: true };
		const weekRest = w.weekendDays.includes(weekday(date));
		return {
			shift: underlying,
			rostered: null,
			rest: !!w.rosterMode || weekRest,
			rosterRest: !!w.rosterMode && !weekRest
		};
	};
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
			weekendDays: workWeeks.weekendDays,
			rosterMode: workWeeks.rosterMode
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

export async function dayRules(tx: Tx, employeeIds: string[], from: string, to: string) {
	const [weekend, weeks, allShifts, assignments, entries] = await Promise.all([
		tenantWeekend(tx),
		workWeekRows(tx, employeeIds, to),
		tx.select().from(shifts),
		employeeIds.length
			? tx
					.select({
						employeeId: shiftAssignments.employeeId,
						effectiveFrom: shiftAssignments.effectiveFrom,
						shiftId: shiftAssignments.shiftId
					})
					.from(shiftAssignments)
					.where(and(inArray(shiftAssignments.employeeId, employeeIds), lte(shiftAssignments.effectiveFrom, to)))
			: [],
		employeeIds.length
			? tx
					.select({
						employeeId: rosterEntries.employeeId,
						date: rosterEntries.date,
						kind: rosterEntries.kind,
						shiftId: rosterEntries.shiftId
					})
					.from(rosterEntries)
					.where(
						and(
							inArray(rosterEntries.employeeId, employeeIds),
							eq(rosterEntries.status, 'published'),
							gte(rosterEntries.date, from),
							lte(rosterEntries.date, to)
						)
					)
			: []
	]);
	return dayRule(weekend, weeks, allShifts, assignments, entries as Entry[]);
}

export async function workingRest(tx: Tx, employeeIds: string[], from: string, to: string): Promise<RestDay> {
	const rule = await dayRules(tx, employeeIds, from, to);
	return (employeeId, date) => rule(employeeId, date).rest;
}
