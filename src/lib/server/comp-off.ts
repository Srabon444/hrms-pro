import { and, eq, inArray, like, sum } from 'drizzle-orm';
import { addDays } from './dates';
import { employees, leaveLedger, leaveTypes, tenantSettings } from './db/schema';
import { appliesTo, fiscalStartMonth } from './leave';
import { fiscalYearOf } from './leave-days';
import { tenantToday } from './lifecycle';
import type { Tx } from './tenancy';

export const compDays = (minutes: number, shift: { halfDayMinutes: number; fullDayMinutes: number }) =>
	minutes >= shift.fullDayMinutes ? 1 : minutes >= shift.halfDayMinutes ? 0.5 : 0;

const compType = async (tx: Tx) => (await tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'compensatory')))[0];

export async function creditCompOff(
	tx: Tx,
	tenantId: string,
	r: { id: string; employeeId: string; date: string },
	days: number,
	userId: string
) {
	const t = await compType(tx);
	const [e] = await tx.select({ gender: employees.gender }).from(employees).where(eq(employees.id, r.employeeId));
	if (!days || !t?.active || !appliesTo(t, e)) return 0;
	const today = await tenantToday(tx);
	const [s] = await tx.select({ expiry: tenantSettings.compOffExpiryDays }).from(tenantSettings);
	await tx.insert(leaveLedger).values({
		tenantId,
		employeeId: r.employeeId,
		leaveTypeId: t.id,
		fiscalYear: fiscalYearOf(today, await fiscalStartMonth(tx)),
		kind: 'comp_credit',
		days,
		period: `ot:${r.id}`,
		refId: r.id,
		expiresOn: addDays(r.date, s?.expiry ?? 90),
		note: `Worked on ${r.date}`,
		createdByUserId: userId
	});
	return days;
}

export async function expireCompOff(tx: Tx, tenantId: string) {
	const t = await compType(tx);
	if (!t) return;
	const today = await tenantToday(tx);
	const fy = fiscalYearOf(today, await fiscalStartMonth(tx));
	const mine = and(eq(leaveLedger.leaveTypeId, t.id), eq(leaveLedger.fiscalYear, fy));
	const credits = await tx
		.select()
		.from(leaveLedger)
		.where(and(mine, eq(leaveLedger.kind, 'comp_credit')))
		.orderBy(leaveLedger.expiresOn, leaveLedger.id);
	const expired = new Map(
		(
			await tx
				.select({ period: leaveLedger.period, days: leaveLedger.days })
				.from(leaveLedger)
				.where(and(mine, eq(leaveLedger.kind, 'expiry'), like(leaveLedger.period, 'comp:%')))
		).map((x) => [x.period!.slice(5), x.days])
	);
	const people = [...new Set(credits.map((c) => c.employeeId))];
	const balance = new Map(
		(
			await tx
				.select({ employeeId: leaveLedger.employeeId, days: sum(leaveLedger.days) })
				.from(leaveLedger)
				.where(and(mine, inArray(leaveLedger.employeeId, people)))
				.groupBy(leaveLedger.employeeId)
		).map((b) => [b.employeeId, Number(b.days)])
	);
	const rows: (typeof leaveLedger.$inferInsert)[] = [];
	for (const employeeId of people) {
		const list = credits.filter((c) => c.employeeId === employeeId);
		const left = balance.get(employeeId) ?? 0;
		for (const [i, c] of list.entries()) {
			if (c.expiresOn! >= today) continue;
			const later = list.slice(i + 1).reduce((n, x) => n + x.days + (expired.get(x.id) ?? 0), 0);
			const unused = Math.min(c.days, Math.max(0, left - later));
			if (unused <= 0) continue;
			rows.push({
				tenantId,
				employeeId,
				leaveTypeId: t.id,
				fiscalYear: fy,
				kind: 'expiry',
				days: -unused,
				period: `comp:${c.id}`,
				refId: c.id,
				note: `Unused compensatory leave expired on ${c.expiresOn}`
			});
		}
	}
	if (rows.length) await tx.insert(leaveLedger).values(rows).onConflictDoNothing();
}
