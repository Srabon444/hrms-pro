import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { instalmentPlan, money, poishaOf } from '../money';
import { activeMemberships, singleAdmin } from './approval-chain';
import type { ApprovalItem } from './approvals';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { employees, LOAN_KINDS, loanInstalments, loans, MAX_INSTALMENTS } from './db/schema';
import { addMonths } from './dates';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { advisoryLock, LOCK } from './locks';
import { notify } from './notifications';
import { can, userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { readSettings, tenantCurrency } from './settings';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

const requestSchema = z.object({
	kind: z.enum(LOAN_KINDS, 'Choose loan or advance.'),
	amount: z
		.string()
		.trim()
		.regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter the amount, up to 2 decimals.')
		.transform(poishaOf)
		.refine((p) => p > 0, 'The amount must be more than zero.'),
	instalments: z.coerce
		.number('Enter the number of instalments.')
		.int('Enter a whole number of instalments.')
		.min(1, 'Repay in at least one instalment.')
		.max(MAX_INSTALMENTS, `Repay in at most ${MAX_INSTALMENTS} instalments.`),
	startPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose the first repayment month.'),
	reason: z.string().trim().min(1, 'Give a reason.').max(300, 'Keep the reason under 300 characters.')
});

const decisionSchema = z.object({
	loanId: z.uuid({ error: 'Choose a request.' }),
	decision: z.enum(['approve', 'reject'], 'Choose approve or reject.'),
	note: z.string().trim().max(300, 'Keep the note under 300 characters.')
});

const loanId = z.object({ loanId: z.uuid({ error: 'Choose a request.' }) });

const notFound = () => new AppError('not_found', 'That request does not exist.', 404);

export async function requestLoan(m: Member, form: Record<string, string>) {
	const input = requestSchema.parse(form);
	const employeeId = m.access.employeeId;
	if (!employeeId) throw new AppError('no_employee', 'Only employees can ask for a loan.', 409);
	if (instalmentPlan(input.amount, input.instalments)[0] === 0)
		throw new AppError('tiny_instalment', 'Each instalment must be at least 1.00.', 400);
	return withTenant(userCtx(m), async (tx) => {
		const [e] = await tx.select({ status: employees.status }).from(employees).where(eq(employees.id, employeeId));
		if (!e || e.status === 'exited') throw new AppError('exited', 'People who have left cannot ask for a loan.', 409);
		const most = (await readSettings(tx)).loanMaxInstalments;
		if (input.instalments > most)
			throw new AppError('too_many_instalments', `Repay in at most ${most} instalments.`, 400);
		if (input.startPeriod < (await tenantToday(tx)).slice(0, 7))
			throw new AppError('past_start', 'Repayment cannot start in a past month.', 400);
		const [row] = await tx
			.insert(loans)
			.values({ tenantId: m.tenant.id, employeeId, ...input, requestedByUserId: m.user.userId })
			.returning({ id: loans.id })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('pending_exists', 'You already have a request waiting for a decision.', 409);
				throw err;
			});
		return row.id;
	});
}

export async function cancelLoan(m: Member, form: Record<string, string>) {
	const input = loanId.parse(form);
	await withTenant(userCtx(m), async (tx) => {
		const [l] = await tx.select().from(loans).where(eq(loans.id, input.loanId));
		if (!l || l.employeeId !== m.access.employeeId) throw notFound();
		if (l.status !== 'requested') throw new AppError('decided', 'Only a request still waiting can be cancelled.', 409);
		await tx.update(loans).set({ status: 'cancelled' }).where(eq(loans.id, l.id));
	});
}

export async function decideLoan(m: Member, form: Record<string, string>) {
	const input = decisionSchema.parse(form);
	return withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const [l] = await tx.select().from(loans).where(eq(loans.id, input.loanId)).for('update');
		if (!l || !inScope(await resolveScope(tx, m.access, 'loan.approve'), l.employeeId)) throw notFound();
		if (l.status !== 'requested') throw new AppError('decided', 'That request is already decided.', 409);
		if (l.employeeId === m.access.employeeId && !(await singleAdmin(tx)))
			throw new AppError('own_loan', 'Someone else must decide your own request.', 403);
		const approved = input.decision === 'approve';
		const [e] = await tx.select({ status: employees.status }).from(employees).where(eq(employees.id, l.employeeId));
		if (approved && e?.status === 'exited')
			throw new AppError('exited', 'This person has left, so the loan cannot be approved. Reject it instead.', 409);
		const thisMonth = (await tenantToday(tx)).slice(0, 7);
		const start = l.startPeriod < thisMonth ? thisMonth : l.startPeriod;
		await tx
			.update(loans)
			.set({
				status: approved ? 'approved' : 'rejected',
				startPeriod: start,
				decidedByUserId: m.user.userId,
				decidedAt: new Date(),
				decisionNote: input.note || null
			})
			.where(eq(loans.id, l.id));
		if (approved)
			await tx.insert(loanInstalments).values(
				instalmentPlan(l.amount, l.instalments).map((amount, i) => ({
					tenantId: m.tenant.id,
					loanId: l.id,
					employeeId: l.employeeId,
					period: addMonths(start, i),
					amount
				}))
			);
		const what = l.kind === 'advance' ? 'Salary advance' : 'Loan';
		return notify(
			tx,
			m.tenant.id,
			await activeMemberships(tx, l.employeeId),
			{
				category: 'approvals',
				title: `${what} ${approved ? 'approved' : 'rejected'}`,
				body: approved
					? `${money(l.amount, await tenantCurrency(tx))} was approved. Repayment of ${l.instalments} instalment(s) starts with the ${start} salary.`
					: input.note || undefined,
				link: 'loans'
			},
			m.tenant.slug
		);
	});
}

const loanFields = {
	id: loans.id,
	employeeId: loans.employeeId,
	kind: loans.kind,
	amount: loans.amount,
	instalments: loans.instalments,
	startPeriod: loans.startPeriod,
	reason: loans.reason,
	status: loans.status,
	createdAt: loans.createdAt,
	name: employees.fullName
};

async function withSchedule<T extends { id: string; amount: number }>(tx: Tx, rows: T[]) {
	const plan = rows.length
		? await tx
				.select({
					loanId: loanInstalments.loanId,
					period: loanInstalments.period,
					amount: loanInstalments.amount,
					status: loanInstalments.status
				})
				.from(loanInstalments)
				.where(
					inArray(
						loanInstalments.loanId,
						rows.map((r) => r.id)
					)
				)
				.orderBy(asc(loanInstalments.period))
		: [];
	return rows.map((r) => {
		const mine = plan.filter((p) => p.loanId === r.id);
		const repaid = mine.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.amount, 0);
		return { ...r, repaid, balance: mine.length ? r.amount - repaid : 0, schedule: mine };
	});
}

export async function loanBoard(tx: Tx, m: Member) {
	const me = m.access.employeeId;
	const scope = await resolveScope(tx, m.access, 'loan.approve');
	const lone = await singleAdmin(tx);
	const base = () => tx.select(loanFields).from(loans).innerJoin(employees, eq(employees.id, loans.employeeId));
	const mine = me ? await base().where(eq(loans.employeeId, me)).orderBy(desc(loans.createdAt)).limit(50) : [];
	const toDecide = await base()
		.where(
			and(
				eq(loans.status, 'requested'),
				scopeWhere(scope, loans.employeeId),
				me && !lone ? ne(loans.employeeId, me) : sql`true`
			)
		)
		.orderBy(asc(loans.createdAt))
		.limit(200);
	const active = await base()
		.where(and(eq(loans.status, 'approved'), scopeWhere(scope, loans.employeeId)))
		.orderBy(asc(employees.fullName))
		.limit(500);
	return {
		today: await tenantToday(tx),
		canRequest: !!me && can(m.access, 'loan.request'),
		maxInstalments: (await readSettings(tx)).loanMaxInstalments,
		mine: await withSchedule(tx, mine),
		toDecide,
		active: await withSchedule(tx, active)
	};
}

export async function loanApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	const scope = await resolveScope(tx, access, 'loan.approve');
	const rows = await tx
		.select(loanFields)
		.from(loans)
		.innerJoin(employees, eq(employees.id, loans.employeeId))
		.where(
			and(
				eq(loans.status, 'requested'),
				scopeWhere(scope, loans.employeeId),
				access.employeeId ? ne(loans.employeeId, access.employeeId) : sql`true`
			)
		)
		.orderBy(asc(loans.createdAt))
		.limit(200);
	const currency = await tenantCurrency(tx);
	return rows.map((r) => ({
		id: r.id,
		kind: r.kind === 'advance' ? 'Salary advance' : 'Loan',
		title: `${r.name}: ${money(r.amount, currency)} over ${r.instalments} month(s)`,
		requestedBy: r.name,
		at: r.createdAt,
		link: 'loans'
	}));
}
