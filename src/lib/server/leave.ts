import { and, asc, desc, eq, inArray, ne, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import { expireCompOff } from './comp-off';
import { csvRecords, ImportFailed, type ImportRowError } from './csv';
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
import { inScope, resolveScope, type ScopeSet } from './rbac/scope';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type LeaveType = typeof leaveTypes.$inferSelect;
type Person = { id: string; joinDate: string; gender: string | null; status: string };
type LedgerRow = typeof leaveLedger.$inferInsert;

export const appliesTo = (t: Pick<LeaveType, 'gender'>, e: { gender: string | null }) =>
	!t.gender || t.gender === e.gender;

const unlimited = (t: Pick<LeaveType, 'quota' | 'accrual'>) => t.quota === null && t.accrual === 'none';

const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

export function leaveRule(t: LeaveType): string {
	const unpaid = t.paid ? '' : ' Unpaid.';
	if (unlimited(t)) return `No limit.${unpaid}`;
	if (t.code === 'compensatory') return `Earned by working on a weekend or holiday.${unpaid}`;
	if (t.accrual === 'none' || t.quota === null) return `Added by HR.${unpaid}`;
	const credit =
		t.accrual === 'monthly'
			? `${plural(t.quota!)} a year, added month by month`
			: `${plural(t.quota!)} a year, added at the start of the year`;
	const joiners = t.proRata ? ', less for people who join mid-year' : '';
	const carry = t.carryCap > 0 ? ` Up to ${plural(t.carryCap)} carry over.` : ' Unused days lapse at year end.';
	return `${credit}${joiners}.${carry}${unpaid}`;
}

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
	const today = await tenantToday(tx);
	const size = sql`case when ${leaveRequestDays.session} = 'full' then 1 else 0.5 end`;
	const requested = await tx
		.select({
			leaveTypeId: leaveRequests.leaveTypeId,
			pending: sql<string>`sum(case when ${leaveRequestDays.status} = 'pending' then ${size} else 0 end)`,
			booked: sql<string>`sum(case when ${leaveRequestDays.status} = 'approved' and ${leaveRequestDays.date} > ${today} then ${size} else 0 end)`
		})
		.from(leaveRequestDays)
		.innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
		.where(
			and(
				eq(leaveRequestDays.employeeId, e.id),
				eq(leaveRequestDays.fiscalYear, fy),
				inArray(leaveRequestDays.status, ['pending', 'approved'])
			)
		)
		.groupBy(leaveRequests.leaveTypeId);
	const by = new Map(sums.map((s) => [s.leaveTypeId, Number(s.days)]));
	const held = new Map(requested.map((s) => [s.leaveTypeId, Number(s.pending)]));
	const ahead = new Map(requested.map((s) => [s.leaveTypeId, Number(s.booked)]));
	return types
		.filter((t) => appliesTo(t, e))
		.map((t) => ({
			id: t.id,
			name: t.name,
			paid: t.paid,
			unlimited: unlimited(t),
			balance: by.get(t.id) ?? 0,
			pending: held.get(t.id) ?? 0,
			booked: ahead.get(t.id) ?? 0,
			available: (by.get(t.id) ?? 0) - (held.get(t.id) ?? 0),
			rule: leaveRule(t)
		}));
}

export const HISTORY_LIMIT = 500;

const carriedFirst = sql`case when ${leaveLedger.kind} = 'carry' then 0 else 1 end`;

export async function leaveHistory(tx: Tx, employeeId: string, fy: number) {
	return tx
		.select({
			id: leaveLedger.id,
			leaveTypeId: leaveLedger.leaveTypeId,
			kind: leaveLedger.kind,
			days: leaveLedger.days,
			period: leaveLedger.period,
			note: leaveLedger.note,
			on: sql<string>`to_char(${leaveLedger.createdAt} at time zone coalesce((select timezone from tenant_settings), 'UTC'), 'YYYY-MM-DD')`,
			requestId: leaveRequests.id,
			from: leaveRequests.startDate,
			to: leaveRequests.endDate,
			files:
				sql<number>`(select count(*) from files f where f.owner_type = 'leave_request' and f.owner_id = ${leaveRequests.id})`.mapWith(
					Number
				),
			after:
				sql<number>`sum(${leaveLedger.days}) over (partition by ${leaveLedger.leaveTypeId} order by ${leaveLedger.createdAt}, ${carriedFirst}, ${leaveLedger.period}, ${leaveLedger.id})`.mapWith(
					Number
				)
		})
		.from(leaveLedger)
		.leftJoin(leaveRequests, and(eq(leaveLedger.kind, 'taken'), eq(leaveRequests.id, leaveLedger.refId)))
		.where(and(eq(leaveLedger.employeeId, employeeId), eq(leaveLedger.fiscalYear, fy)))
		.orderBy(desc(leaveLedger.createdAt), desc(carriedFirst), desc(leaveLedger.period), desc(leaveLedger.id))
		.limit(HISTORY_LIMIT);
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

function adjustmentProblem(
	manage: ScopeSet,
	access: Access,
	e: { id: string; gender: string | null },
	t: LeaveType | undefined,
	balance: number,
	days: number
): [code: string, message: string, status: number] | null {
	if (!inScope(manage, e.id)) return ['forbidden', 'You cannot adjust leave for this person.', 403];
	if (access.employeeId === e.id) return ['self_change', 'Someone else has to adjust your own leave.', 403];
	if (!t || !t.active || !appliesTo(t, e)) return ['unknown_type', 'Choose a leave type that applies.', 400];
	if (!unlimited(t) && balance + days < 0)
		return ['negative_balance', `Only ${balance} day(s) of ${t.name} can be removed.`, 409];
	return null;
}

export async function adjustLeave(m: Member, employeeId: string, raw: Record<string, string>) {
	const input = adjustSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const e = await lockEmployee(tx, m.access, employeeId);
		const [t] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, input.leaveTypeId));
		const fy = fiscalYearOf(await tenantToday(tx), await fiscalStartMonth(tx));
		const balance = t ? ((await balanceRows(tx, e, fy)).find((b) => b.id === t.id)?.balance ?? 0) : 0;
		const problem = adjustmentProblem(
			await resolveScope(tx, m.access, 'leave.manage'),
			m.access,
			e,
			t,
			balance,
			input.days
		);
		if (problem) throw new AppError(...problem);
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

export const MAX_BALANCE_ROWS = 2000;
export const BALANCE_COLUMNS = ['employee_code', 'leave_type_code', 'balance', 'note'] as const;
const BALANCE_RANGE = 'Use whole or half days from 0 to 366.';
const openingSchema = z.object({
	balance: z
		.string()
		.trim()
		.regex(/^\d{1,3}(\.[05])?$/, BALANCE_RANGE)
		.transform(Number)
		.refine((n) => n <= 366, BALANCE_RANGE),
	note: adjustSchema.shape.note
});

export async function importLeaveBalances(m: Member, table: string[][]): Promise<number> {
	const rows = csvRecords(table, BALANCE_COLUMNS, MAX_BALANCE_ROWS);
	return withTenant(userCtx(m), async (tx) => {
		const visible = await resolveScope(tx, m.access, 'employee.read');
		const manage = await resolveScope(tx, m.access, 'leave.manage');
		const people = new Map(
			(
				await tx
					.select()
					.from(employees)
					.where(inArray(employees.code, [...new Set(rows.map((r) => r.v.employee_code))]))
					.orderBy(asc(employees.id))
					.for('update')
			)
				.filter((e) => inScope(visible, e.id))
				.map((e) => [e.code, e])
		);
		const types = new Map((await tx.select().from(leaveTypes)).map((t) => [t.code, t]));
		const fy = fiscalYearOf(await tenantToday(tx), await fiscalStartMonth(tx));
		const current = new Map(
			(
				await tx
					.select({ e: leaveLedger.employeeId, t: leaveLedger.leaveTypeId, days: sum(leaveLedger.days) })
					.from(leaveLedger)
					.where(
						and(
							eq(leaveLedger.fiscalYear, fy),
							inArray(
								leaveLedger.employeeId,
								[...people.values()].map((e) => e.id)
							)
						)
					)
					.groupBy(leaveLedger.employeeId, leaveLedger.leaveTypeId)
			).map((s) => [`${s.e}:${s.t}`, Number(s.days)])
		);
		const seen = new Set<string>();
		const errors: ImportRowError[] = [];
		const list: LedgerRow[] = [];
		let changed = 0;
		for (const { line, v } of rows) {
			const parsed = openingSchema.safeParse(v);
			const e = people.get(v.employee_code);
			const t = types.get(v.leave_type_code);
			const key = `${e?.id}:${t?.id}`;
			const was = current.get(key) ?? 0;
			const message = !parsed.success
				? parsed.error.issues[0].message
				: !e
					? 'No employee has this code.'
					: (adjustmentProblem(manage, m.access, e, t, was, parsed.data.balance - was)?.[1] ??
						(unlimited(t!)
							? `${t!.name} has no balance to set.`
							: seen.has(key)
								? 'This person and leave type appear twice in the file.'
								: null));
			seen.add(key);
			if (message) errors.push({ line, message });
			else if (parsed.data!.balance !== was) {
				changed += 1;
				for (let left = Math.round((parsed.data!.balance - was) * 100) / 100; left;) {
					const days = Math.sign(left) * Math.min(Math.abs(left), 366);
					left = Math.round((left - days) * 100) / 100;
					list.push({
						tenantId: m.tenant.id,
						employeeId: e!.id,
						leaveTypeId: t!.id,
						fiscalYear: fy,
						kind: 'adjustment',
						days,
						note: parsed.data!.note,
						createdByUserId: m.user.userId
					});
				}
			}
		}
		if (errors.length) throw new ImportFailed(errors);
		await insertLedger(tx, list);
		return changed;
	});
}
