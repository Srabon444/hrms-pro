import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { discardFiles, insertFiles, prepareFiles, type AttachmentRules } from './attachments';
import { recomputeAttendance } from './attendance';
import { addDays } from './dates';
import {
	departments,
	employees,
	holidays,
	LEAVE_SESSIONS,
	leaveLedger,
	leaveRequestDays,
	leaveRequests,
	leaveTypes,
	tenantSettings
} from './db/schema';
import { AppError } from './errors';
import { lockEmployee } from './employees';
import { activeMemberships, approvers, deciderWhere, rightsOver, singleAdmin } from './approval-chain';
import { appliesTo, balanceRows, fiscalStartMonth } from './leave';
import { dayValue, fiscalYearOf, fiscalYearRange, leaveDays, type Calendar, type Session } from './leave-days';
import { tenantToday } from './lifecycle';
import { notify, sendAll } from './notifications';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';
import type { ApprovalItem } from './approvals';

type Member = ReturnType<typeof requireMember>;
type Request = typeof leaveRequests.$inferSelect;

const ACTIVE = ['pending', 'approved'];
const notFound = () => new AppError('not_found', 'That leave request does not exist.', 404);
const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const note = z
	.string()
	.trim()
	.max(500, 'Keep the note under 500 characters.')
	.transform((v) => v || null);

async function calendar(tx: Tx, start: string, end: string): Promise<Calendar> {
	const [s] = await tx.select({ weekendDays: tenantSettings.weekendDays }).from(tenantSettings);
	const rows = await tx
		.select({ date: holidays.date })
		.from(holidays)
		.where(and(gte(holidays.date, start), lte(holidays.date, end)));
	return { weekendDays: s?.weekendDays ?? [5, 6], holidays: new Set(rows.map((r) => r.date)) };
}

const byYear = (days: { fiscalYear: number; session: string }[]) => {
	const out = new Map<number, number>();
	for (const d of days) out.set(d.fiscalYear, (out.get(d.fiscalYear) ?? 0) + dayValue(d as { session: Session }));
	return [...out];
};

const requestSchema = z
	.object({
		leaveTypeId: z.uuid({ error: 'Choose a leave type.' }),
		startDate: z.iso.date('Enter the first day.'),
		endDate: z.iso.date('Enter the last day.'),
		session: z.enum(LEAVE_SESSIONS, { error: 'Choose a full or half day.' }),
		reason: note
	})
	.refine((v) => v.endDate >= v.startDate, { message: 'The last day cannot be before the first day.' })
	.refine((v) => v.session === 'full' || v.startDate === v.endDate, { message: 'A half day covers one date only.' });

export async function requestLeave(m: Member, raw: Record<string, string>, attached: File[] = []) {
	const input = requestSchema.parse({ ...raw, endDate: raw.endDate || raw.startDate, session: raw.session || 'full' });
	const stored = attached.length ? await prepareFiles(m.tenant.id, 'leave_request', attached) : [];
	const { id, mails } = await withTenant(userCtx(m), async (tx) => {
		if (!m.access.employeeId)
			throw new AppError('no_employee', 'Your account is not linked to an employee record.', 403);
		const e = await lockEmployee(tx, m.access, m.access.employeeId);
		if (!inScope(await resolveScope(tx, m.access, 'leave.request'), e.id))
			throw new AppError('forbidden', 'You cannot request leave.', 403);
		const [t] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, input.leaveTypeId));
		if (!t || !t.active || !appliesTo(t, e))
			throw new AppError('unknown_type', 'Choose a leave type that applies.', 400);
		if (input.session !== 'full' && !t.halfDayAllowed)
			throw new AppError('no_half_day', `${t.name} is taken in full days only.`, 400);
		const today = await tenantToday(tx);
		const startMonth = await fiscalStartMonth(tx);
		const fy = fiscalYearOf(today, startMonth);
		const year = fiscalYearRange(fy, startMonth);
		if (input.startDate < year.start || input.endDate > year.end)
			throw new AppError('outside_year', `Leave must fall in this fiscal year, ${year.start} to ${year.end}.`, 400);
		if (input.startDate < e.joinDate || (e.exitDate && input.endDate > e.exitDate))
			throw new AppError('outside_employment', 'Leave must fall between your join date and last day.', 400);
		if (input.startDate < addDays(today, t.minNoticeDays))
			throw new AppError('short_notice', `Ask for ${t.name} at least ${plural(t.minNoticeDays)} ahead.`, 400);
		if (
			!t.duringProbation &&
			(e.status === 'probation' || (!!e.probationEndDate && input.startDate <= e.probationEndDate))
		)
			throw new AppError('probation', `${t.name} opens after probation.`, 400);

		const list = leaveDays(
			input.startDate,
			input.endDate,
			input.session,
			await calendar(tx, input.startDate, input.endDate),
			t.sandwich
		);
		if (!list.length) throw new AppError('no_working_days', 'Those dates are all weekends or holidays.', 400);
		const total = list.reduce((n, d) => n + dayValue(d), 0);
		if (t.maxConsecutive && total > t.maxConsecutive)
			throw new AppError('too_long', `${t.name} runs at most ${plural(t.maxConsecutive)} at a time.`, 400);
		const taken = await tx
			.select({ date: leaveRequestDays.date, session: leaveRequestDays.session })
			.from(leaveRequestDays)
			.where(
				and(
					eq(leaveRequestDays.employeeId, e.id),
					inArray(leaveRequestDays.status, ACTIVE),
					gte(leaveRequestDays.date, input.startDate),
					lte(leaveRequestDays.date, input.endDate)
				)
			);
		if (
			list.some((d) =>
				taken.some(
					(x) => x.date === d.date && (x.session === 'full' || d.session === 'full' || x.session === d.session)
				)
			)
		)
			throw new AppError('overlap', 'You already have leave on some of those days.', 409);
		const row = (await balanceRows(tx, e, fy)).find((b) => b.id === t.id)!;
		if (!row.unlimited && total > row.available)
			throw new AppError('insufficient', `You have ${plural(row.available)} of ${t.name} left.`, 409);

		const [req] = await tx
			.insert(leaveRequests)
			.values({
				tenantId: m.tenant.id,
				employeeId: e.id,
				leaveTypeId: t.id,
				startDate: input.startDate,
				endDate: input.endDate,
				session: input.session,
				days: total,
				reason: input.reason,
				requestedByUserId: m.user.userId
			})
			.returning({ id: leaveRequests.id });
		await tx.insert(leaveRequestDays).values(
			list.map((d) => ({
				tenantId: m.tenant.id,
				requestId: req.id,
				employeeId: e.id,
				date: d.date,
				session: d.session,
				fiscalYear: fy,
				status: 'pending'
			}))
		);
		if (stored.length) await insertFiles(tx, userCtx(m), 'leave_request', req.id, stored);
		const mails = await notify(
			tx,
			m.tenant.id,
			await approvers(tx, e, 'leave'),
			{
				category: 'approvals',
				title: `${e.fullName} asked for ${t.name}`,
				body: `${input.startDate} to ${input.endDate}, ${plural(total)}.`,
				link: `approvals/leave/${req.id}`
			},
			m.tenant.slug
		);
		return { id: req.id, mails };
	}).catch(async (err) => {
		await discardFiles(stored);
		throw err;
	});
	await sendAll(mails);
	return id;
}

export const leaveAttachments: AttachmentRules = {
	async canRead(tx, access, id) {
		const [r] = await tx
			.select({ employeeId: leaveRequests.employeeId })
			.from(leaveRequests)
			.where(eq(leaveRequests.id, id));
		if (!r) return false;
		const [e] = await tx.select().from(employees).where(eq(employees.id, r.employeeId));
		const rights = await rightsOver(tx, access, e, 'leave');
		return rights.own || rights.canDecide || inScope(await resolveScope(tx, access, 'leave.manage'), e.id);
	},
	async canEdit(tx, access, id, lock) {
		const q = tx
			.select({ employeeId: leaveRequests.employeeId, status: leaveRequests.status })
			.from(leaveRequests)
			.where(eq(leaveRequests.id, id));
		const [r] = lock ? await q.for('update') : await q;
		return !!r && r.status === 'pending' && r.employeeId === access.employeeId;
	}
};

async function load(tx: Tx, access: Access, requestId: string, lock: boolean) {
	const id = z.uuid().safeParse(requestId);
	if (!id.success) return null;
	const q = tx.select().from(leaveRequests).where(eq(leaveRequests.id, id.data));
	const [r] = lock ? await q.for('update') : await q;
	if (!r) return null;
	const [e] = await tx.select().from(employees).where(eq(employees.id, r.employeeId));
	const rights = await rightsOver(tx, access, e, 'leave');
	return rights.canView ? { r, e, rights } : null;
}

const cancellable = (r: Request, today: string) =>
	r.status === 'pending' || (r.status === 'approved' && r.startDate > today);

const ledgerRows = (r: Request, days: { fiscalYear: number; session: string }[], sign: 1 | -1, userId: string | null) =>
	byYear(days).map(([fiscalYear, n]) => ({
		tenantId: r.tenantId,
		employeeId: r.employeeId,
		leaveTypeId: r.leaveTypeId,
		fiscalYear,
		kind: 'taken',
		days: sign * n,
		refId: r.id,
		createdByUserId: userId
	}));

async function tellOwner(tx: Tx, m: Member, r: Request, title: string, body?: string) {
	return notify(
		tx,
		m.tenant.id,
		await activeMemberships(tx, r.employeeId),
		{ category: 'approvals', title, body, link: 'leave' },
		m.tenant.slug
	);
}

export async function getLeaveRequest(tx: Tx, access: Access, requestId: string) {
	const found = await load(tx, access, requestId, false);
	if (!found) return null;
	const { r, e, rights } = found;
	const [t] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, r.leaveTypeId));
	const days = await tx
		.select({ date: leaveRequestDays.date, session: leaveRequestDays.session })
		.from(leaveRequestDays)
		.where(
			and(
				eq(leaveRequestDays.requestId, r.id),
				inArray(leaveRequestDays.status, ACTIVE.includes(r.status) ? ACTIVE : [r.status])
			)
		)
		.orderBy(asc(leaveRequestDays.date));
	const fy = fiscalYearOf(r.startDate, await fiscalStartMonth(tx));
	const balance = rights.canDecide ? (await balanceRows(tx, e, fy)).find((b) => b.id === t.id) : undefined;
	return {
		id: r.id,
		status: r.status,
		employee: { id: e.id, code: e.code, fullName: e.fullName },
		type: t.name,
		startDate: r.startDate,
		endDate: r.endDate,
		session: r.session,
		days: r.days,
		dates: days.map((d) => d.date),
		reason: r.reason,
		decisionNote: r.decisionNote,
		balance: balance && !balance.unlimited ? balance : null,
		canDecide: rights.canDecide && r.status === 'pending',
		canCancel: rights.canCancel && cancellable(r, await tenantToday(tx))
	};
}

async function ensureCovered(tx: Tx, r: Request, e: { id: string; gender: string | null }) {
	await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, e.id)).for('update');
	const days = await tx
		.select({ fiscalYear: leaveRequestDays.fiscalYear, session: leaveRequestDays.session })
		.from(leaveRequestDays)
		.where(and(eq(leaveRequestDays.requestId, r.id), eq(leaveRequestDays.status, 'pending')));
	for (const [fy, n] of byYear(days)) {
		const row = (await balanceRows(tx, e, fy)).find((b) => b.id === r.leaveTypeId);
		if (row && !row.unlimited && row.balance < n)
			throw new AppError(
				'insufficient',
				`Only ${plural(row.balance)} of ${row.name} is left, so this request cannot be approved.`,
				409
			);
	}
}

const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), note });

export async function decideLeave(m: Member, requestId: string, raw: Record<string, string>) {
	const { decision, note } = decisionSchema.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		const found = await load(tx, m.access, requestId, true);
		if (!found) throw notFound();
		const { r, rights } = found;
		if (r.status !== 'pending') throw new AppError('already_decided', 'This request was already handled.', 409);
		if (!rights.canDecide)
			throw rights.own
				? new AppError('self_approval', 'Someone else has to decide on your own leave.', 403)
				: new AppError('forbidden', 'You cannot decide on this request.', 403);
		const status = decision === 'approve' ? 'approved' : 'rejected';
		if (status === 'approved') await ensureCovered(tx, r, found.e);
		await tx
			.update(leaveRequests)
			.set({ status, decidedByUserId: m.user.userId, decidedAt: new Date(), decisionNote: note })
			.where(eq(leaveRequests.id, r.id));
		const days = await tx
			.update(leaveRequestDays)
			.set({ status })
			.where(and(eq(leaveRequestDays.requestId, r.id), eq(leaveRequestDays.status, 'pending')))
			.returning({ fiscalYear: leaveRequestDays.fiscalYear, session: leaveRequestDays.session });
		if (status === 'approved') {
			await tx.insert(leaveLedger).values(ledgerRows(r, days, -1, m.user.userId));
			await recomputeAttendance(tx, m.tenant.id, r.startDate, r.endDate, [r.employeeId]);
		}
		return tellOwner(
			tx,
			m,
			r,
			`Your leave from ${r.startDate} was ${status === 'approved' ? 'approved' : 'declined'}`,
			note ?? undefined
		);
	});
	await sendAll(mails);
}

export async function cancelLeave(m: Member, requestId: string) {
	const mails = await withTenant(userCtx(m), async (tx) => {
		const found = await load(tx, m.access, requestId, true);
		if (!found) throw notFound();
		const { r, rights } = found;
		if (!rights.canCancel) throw new AppError('forbidden', 'You cannot cancel this request.', 403);
		if (!cancellable(r, await tenantToday(tx)))
			throw new AppError('not_cancellable', 'Only pending or upcoming leave can be cancelled.', 409);
		await tx.update(leaveRequests).set({ status: 'cancelled' }).where(eq(leaveRequests.id, r.id));
		const days = await tx
			.update(leaveRequestDays)
			.set({ status: 'cancelled' })
			.where(and(eq(leaveRequestDays.requestId, r.id), inArray(leaveRequestDays.status, ACTIVE)))
			.returning({ fiscalYear: leaveRequestDays.fiscalYear, session: leaveRequestDays.session });
		if (r.status === 'approved') await tx.insert(leaveLedger).values(ledgerRows(r, days, 1, m.user.userId));
		return rights.own ? [] : tellOwner(tx, m, r, `Your leave from ${r.startDate} was cancelled`);
	});
	await sendAll(mails);
}

export async function dropHolidayFromLeave(tx: Tx, date: string) {
	if (date < (await tenantToday(tx))) return;
	const hit = await tx
		.selectDistinct({ id: leaveRequestDays.requestId })
		.from(leaveRequestDays)
		.where(and(eq(leaveRequestDays.date, date), inArray(leaveRequestDays.status, ACTIVE)));
	const ids = hit.map((h) => h.id);
	const requests = await tx
		.select({ r: leaveRequests, sandwich: leaveTypes.sandwich })
		.from(leaveRequests)
		.innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
		.where(inArray(leaveRequests.id, ids))
		.for('update', { of: leaveRequests });
	const days = await tx
		.select()
		.from(leaveRequestDays)
		.where(and(inArray(leaveRequestDays.requestId, ids), inArray(leaveRequestDays.status, ACTIVE)));
	const cal = await calendar(
		tx,
		requests.reduce((a, x) => (x.r.startDate < a ? x.r.startDate : a), date),
		requests.reduce((a, x) => (x.r.endDate > a ? x.r.endDate : a), date)
	);
	const dropped: typeof days = [];
	for (const { r, sandwich } of requests) {
		const keep = new Set(leaveDays(r.startDate, r.endDate, r.session as Session, cal, sandwich).map((d) => d.date));
		dropped.push(...days.filter((d) => d.requestId === r.id && !keep.has(d.date)));
	}
	await tx
		.update(leaveRequestDays)
		.set({ status: 'cancelled' })
		.where(
			inArray(
				leaveRequestDays.id,
				dropped.map((d) => d.id)
			)
		);
	const refunds = requests
		.filter(({ r }) => r.status === 'approved')
		.flatMap(({ r }) =>
			ledgerRows(
				r,
				dropped.filter((d) => d.requestId === r.id),
				1,
				null
			)
		);
	if (refunds.length) await tx.insert(leaveLedger).values(refunds);
	const left = sql`(select coalesce(sum(case when d.session = 'full' then 1 else 0.5 end), 0) from leave_request_days d where d.request_id = ${leaveRequests.id} and d.status in ('pending','approved'))`;
	await tx
		.update(leaveRequests)
		.set({ days: left, status: sql`case when ${left} = 0 then 'cancelled' else ${leaveRequests.status} end` })
		.where(inArray(leaveRequests.id, ids));
}

export async function myLeave(tx: Tx, access: Access) {
	if (!access.employeeId) return [];
	const today = await tenantToday(tx);
	const rows = await tx
		.select({ r: leaveRequests, type: leaveTypes.name })
		.from(leaveRequests)
		.innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
		.where(eq(leaveRequests.employeeId, access.employeeId))
		.orderBy(desc(leaveRequests.startDate), desc(leaveRequests.createdAt))
		.limit(50);
	return rows.map(({ r, type }) => ({
		id: r.id,
		type,
		startDate: r.startDate,
		endDate: r.endDate,
		session: r.session,
		days: r.days,
		status: r.status,
		cancellable: cancellable(r, today)
	}));
}

export async function whoIsOut(tx: Tx, access: Access, from: string, to: string) {
	const [seen, detail] = await Promise.all([
		resolveScope(tx, access, 'employee.read'),
		resolveScope(tx, access, 'leave.read')
	]);
	const [me] = access.employeeId
		? await tx.select({ dept: employees.departmentId }).from(employees).where(eq(employees.id, access.employeeId))
		: [];
	const rows = await tx
		.select({
			date: leaveRequestDays.date,
			session: leaveRequestDays.session,
			employeeId: employees.id,
			name: employees.fullName,
			type: leaveTypes.name
		})
		.from(leaveRequestDays)
		.innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
		.innerJoin(employees, eq(employees.id, leaveRequestDays.employeeId))
		.innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
		.where(
			and(
				eq(leaveRequestDays.status, 'approved'),
				gte(leaveRequestDays.date, from),
				lte(leaveRequestDays.date, to),
				me?.dept
					? or(scopeWhere(seen, employees.id), eq(employees.departmentId, me.dept))
					: scopeWhere(seen, employees.id)
			)
		)
		.orderBy(asc(leaveRequestDays.date), asc(employees.fullName))
		.limit(500);
	return rows.map((r) => ({
		date: r.date,
		session: r.session,
		name: r.name,
		type: inScope(detail, r.employeeId) ? r.type : 'Out'
	}));
}

export async function leaveApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	const me = access.employeeId;
	const where = await deciderWhere(tx, access, 'leave');
	const rows = await tx
		.select({
			id: leaveRequests.id,
			at: leaveRequests.createdAt,
			name: employees.fullName,
			employeeId: employees.id,
			type: leaveTypes.name,
			days: leaveRequests.days
		})
		.from(leaveRequests)
		.innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
		.innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
		.leftJoin(departments, eq(departments.id, employees.departmentId))
		.where(and(eq(leaveRequests.status, 'pending'), where))
		.orderBy(asc(leaveRequests.createdAt))
		.limit(200);
	const single = rows.some((r) => r.employeeId === me) && (await singleAdmin(tx));
	return rows
		.filter((r) => r.employeeId !== me || single)
		.map((r) => ({
			id: r.id,
			kind: 'Leave',
			title: `${r.name}: ${r.type}, ${plural(r.days)}`,
			requestedBy: r.name,
			at: r.at,
			link: `approvals/leave/${r.id}`
		}));
}
