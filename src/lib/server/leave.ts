import { and, asc, eq, inArray, ne, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import { expireCompOff } from './comp-off';
import { authPool } from './db';
import {
	employees,
	leaveLedger,
	leaveRequestDays,
	leaveRequests,
	leaveTypes,
	tenants,
	tenantSettings
} from './db/schema';
import { AppError } from './errors';
import { lockEmployee } from './employees';
import { fiscalYearOf, fiscalYearRange, monthlyCredits, proRataQuota } from './leave-days';
import { tenantToday } from './lifecycle';
import { log } from './log';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type LeaveType = typeof leaveTypes.$inferSelect;
type Person = { id: string; joinDate: string; gender: string | null; status: string };
type LedgerRow = typeof leaveLedger.$inferInsert;

export const appliesTo = (t: Pick<LeaveType, 'gender'>, e: { gender: string | null }) =>
	!t.gender || t.gender === e.gender;

export async function fiscalStartMonth(tx: Tx) {
	const [s] = await tx.select({ m: tenantSettings.fiscalYearStartMonth }).from(tenantSettings);
	return s?.m ?? 7;
}

function credits(tenantId: string, e: Person, types: LeaveType[], fy: number, startMonth: number, asOf: string) {
	const { start } = fiscalYearRange(fy, startMonth);
	const rows: LedgerRow[] = [];
	for (const t of types) {
		if (t.quota === null || t.accrual === 'none' || !appliesTo(t, e)) continue;
		const base = { tenantId, employeeId: e.id, leaveTypeId: t.id, fiscalYear: fy, kind: 'accrual' };
		if (t.accrual === 'yearly') {
			const days = t.proRata ? proRataQuota(t.quota, start, e.joinDate) : t.quota;
			if (days > 0) rows.push({ ...base, days, period: String(fy) });
		} else
			for (const c of monthlyCredits(t.quota, start, e.joinDate, asOf))
				if (c.days > 0) rows.push({ ...base, days: c.days, period: c.period });
	}
	return rows;
}

async function rollover(tx: Tx, tenantId: string, people: Person[], types: LeaveType[], fy: number) {
	if (!people.length) return [];
	const sums = await tx
		.select({ employeeId: leaveLedger.employeeId, leaveTypeId: leaveLedger.leaveTypeId, days: sum(leaveLedger.days) })
		.from(leaveLedger)
		.where(
			and(
				eq(leaveLedger.fiscalYear, fy - 1),
				inArray(
					leaveLedger.employeeId,
					people.map((p) => p.id)
				)
			)
		)
		.groupBy(leaveLedger.employeeId, leaveLedger.leaveTypeId);
	const cap = new Map(types.map((t) => [t.id, t.carryCap]));
	const rows: LedgerRow[] = [];
	for (const s of sums) {
		const balance = Number(s.days);
		const carry = Math.min(balance, cap.get(s.leaveTypeId) ?? 0);
		const base = { tenantId, employeeId: s.employeeId, leaveTypeId: s.leaveTypeId, period: 'rollover' };
		if (carry > 0) rows.push({ ...base, fiscalYear: fy, kind: 'carry', days: carry });
		if (balance > carry) rows.push({ ...base, fiscalYear: fy - 1, kind: 'expiry', days: -(balance - carry) });
	}
	return rows;
}

const insertLedger = async (tx: Tx, rows: LedgerRow[]) => {
	for (let i = 0; i < rows.length; i += 1000)
		await tx
			.insert(leaveLedger)
			.values(rows.slice(i, i + 1000))
			.onConflictDoNothing();
};

export async function accrue(tx: Tx, tenantId: string, employeeIds?: string[]) {
	const today = await tenantToday(tx);
	const startMonth = await fiscalStartMonth(tx);
	const fy = fiscalYearOf(today, startMonth);
	const prev = fiscalYearRange(fy - 1, startMonth);
	const types = await tx.select().from(leaveTypes).where(eq(leaveTypes.active, true));
	const people = await tx
		.select({ id: employees.id, joinDate: employees.joinDate, gender: employees.gender, status: employees.status })
		.from(employees)
		.where(
			and(
				ne(employees.status, 'exited'),
				sql`${employees.joinDate} <= ${today}`,
				employeeIds ? inArray(employees.id, employeeIds) : undefined
			)
		);
	await insertLedger(
		tx,
		people.flatMap((p) => credits(tenantId, p, types, fy - 1, startMonth, prev.end))
	);
	await insertLedger(tx, await rollover(tx, tenantId, people, types, fy));
	await insertLedger(
		tx,
		people.flatMap((p) => credits(tenantId, p, types, fy, startMonth, today))
	);
}

export async function runLeaveAccrual() {
	const list = await authPool().db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
	for (const t of list)
		await withTenant(systemCtx(t.id), async (tx) => {
			await accrue(tx, t.id);
			await expireCompOff(tx, t.id);
		}).catch((err) => log.error({ tenantId: t.id, err: (err as Error).message }, 'leave accrual failed'));
}

export async function balanceRows(tx: Tx, e: { id: string; gender: string | null }, fy: number) {
	const types = await tx.select().from(leaveTypes).where(eq(leaveTypes.active, true)).orderBy(asc(leaveTypes.name));
	const sums = await tx
		.select({ leaveTypeId: leaveLedger.leaveTypeId, days: sum(leaveLedger.days) })
		.from(leaveLedger)
		.where(and(eq(leaveLedger.employeeId, e.id), eq(leaveLedger.fiscalYear, fy)))
		.groupBy(leaveLedger.leaveTypeId);
	const pending = await tx
		.select({
			leaveTypeId: leaveRequests.leaveTypeId,
			days: sql<string>`sum(case when ${leaveRequestDays.session} = 'full' then 1 else 0.5 end)`
		})
		.from(leaveRequestDays)
		.innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
		.where(
			and(
				eq(leaveRequestDays.employeeId, e.id),
				eq(leaveRequestDays.fiscalYear, fy),
				eq(leaveRequestDays.status, 'pending')
			)
		)
		.groupBy(leaveRequests.leaveTypeId);
	const by = new Map(sums.map((s) => [s.leaveTypeId, Number(s.days)]));
	const held = new Map(pending.map((s) => [s.leaveTypeId, Number(s.days)]));
	return types
		.filter((t) => appliesTo(t, e))
		.map((t) => ({
			id: t.id,
			name: t.name,
			paid: t.paid,
			unlimited: t.quota === null && t.accrual === 'none',
			balance: by.get(t.id) ?? 0,
			pending: held.get(t.id) ?? 0,
			available: (by.get(t.id) ?? 0) - (held.get(t.id) ?? 0)
		}));
}

export async function ownBalances(tx: Tx, access: Access) {
	const fy = fiscalYearOf(await tenantToday(tx), await fiscalStartMonth(tx));
	const [me] = access.employeeId
		? await tx
				.select({ id: employees.id, gender: employees.gender })
				.from(employees)
				.where(eq(employees.id, access.employeeId))
		: [];
	return { fy, rows: me ? await balanceRows(tx, me, fy) : [] };
}

export async function leaveBalances(tx: Tx, access: Access, e: { id: string; gender: string | null }) {
	if (!inScope(await resolveScope(tx, access, 'leave.read'), e.id)) return null;
	const startMonth = await fiscalStartMonth(tx);
	const fy = fiscalYearOf(await tenantToday(tx), startMonth);
	const canAdjust = access.employeeId !== e.id && inScope(await resolveScope(tx, access, 'leave.manage'), e.id);
	return { fy, rows: await balanceRows(tx, e, fy), canAdjust };
}

const adjustSchema = z.object({
	leaveTypeId: z.uuid({ error: 'Choose a leave type.' }),
	days: z.coerce
		.number('Enter the days to add or remove.')
		.refine((n) => n !== 0 && Math.abs(n) <= 366 && Number.isInteger(n * 2), 'Use whole or half days, up to 366.'),
	note: z.string().trim().min(1, 'Say why the balance changes.').max(500, 'Keep the note under 500 characters.')
});

export async function adjustLeave(m: Member, employeeId: string, raw: Record<string, string>) {
	const input = adjustSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const e = await lockEmployee(tx, m.access, employeeId);
		if (!inScope(await resolveScope(tx, m.access, 'leave.manage'), e.id))
			throw new AppError('forbidden', 'You cannot adjust leave for this person.', 403);
		if (m.access.employeeId === e.id)
			throw new AppError('self_change', 'Someone else has to adjust your own leave.', 403);
		const [t] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, input.leaveTypeId));
		if (!t || !t.active || !appliesTo(t, e))
			throw new AppError('unknown_type', 'Choose a leave type that applies.', 400);
		const fy = fiscalYearOf(await tenantToday(tx), await fiscalStartMonth(tx));
		await tx.insert(leaveLedger).values({
			tenantId: m.tenant.id,
			employeeId: e.id,
			leaveTypeId: t.id,
			fiscalYear: fy,
			kind: 'adjustment',
			days: input.days,
			note: input.note,
			createdByUserId: m.user.userId
		});
	});
}
