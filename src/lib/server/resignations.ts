import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { addDays } from './dates';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { employees, memberships, resignations, tenantSettings } from './db/schema';
import { AppError } from './errors';
import { lockEmployee } from './employees';
import { applyExit, hrMemberships } from './exits';
import { tenantToday } from './lifecycle';
import { notify, sendAll } from './notifications';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';
import type { ApprovalItem } from './approvals';
import type { Mail } from './mail';

type Member = ReturnType<typeof requireMember>;
type Resignation = typeof resignations.$inferSelect;

const OPEN = ['pending_manager', 'pending_hr'] as const;
const notFound = () => new AppError('not_found', 'That resignation does not exist.', 404);
const note = z
	.string()
	.trim()
	.max(500, 'Keep the note under 500 characters.')
	.transform((v) => v || null);

export async function noticeTerms(tx: Tx) {
	const [s] = await tx.select({ days: tenantSettings.noticePeriodDays }).from(tenantSettings);
	const today = await tenantToday(tx);
	const noticeDays = s?.days ?? 30;
	return { today, noticeDays, earliest: addDays(today, noticeDays) };
}

async function managerMemberships(tx: Tx, managerId: string | null): Promise<string[]> {
	if (!managerId) return [];
	const rows = await tx
		.select({ id: memberships.id })
		.from(memberships)
		.where(and(eq(memberships.employeeId, managerId), eq(memberships.status, 'active')));
	return rows.map((r) => r.id);
}

async function ownerMemberships(tx: Tx, employeeId: string): Promise<string[]> {
	const rows = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.employeeId, employeeId));
	return rows.map((r) => r.id);
}

const submitSchema = z.object({
	lastDay: z.iso.date('Enter your last working day.'),
	reason: z.string().trim().min(1, 'Tell us why you are leaving.').max(500, 'Keep the reason under 500 characters.')
});

export async function submitResignation(m: Member, employeeId: string, raw: Record<string, string>) {
	const input = submitSchema.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		const e = await lockEmployee(tx, m.access, employeeId);
		if (m.access.employeeId !== e.id) throw new AppError('forbidden', 'You can only resign for yourself.', 403);
		if (e.status === 'notice' || e.status === 'exited')
			throw new AppError('already_leaving', 'Your exit is already recorded.', 409);
		const terms = await noticeTerms(tx);
		if (input.lastDay < terms.today) throw new AppError('before_today', 'Your last day cannot be in the past.', 400);
		const approvers = await managerMemberships(tx, e.managerId);
		const status = approvers.length ? 'pending_manager' : 'pending_hr';
		await tx
			.insert(resignations)
			.values({
				tenantId: m.tenant.id,
				employeeId: e.id,
				requestedByUserId: m.user.userId,
				submittedOn: terms.today,
				noticeDays: terms.noticeDays,
				requestedLastDay: input.lastDay,
				reason: input.reason,
				status
			})
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('resignation_pending', 'Your resignation is already waiting for a decision.', 409);
				throw err;
			});
		return notify(
			tx,
			m.tenant.id,
			status === 'pending_manager' ? approvers : await hrMemberships(tx),
			{
				category: 'approvals',
				title: `${e.fullName} has resigned`,
				body: `Requested last day: ${input.lastDay}.`,
				link: 'approvals'
			},
			m.tenant.slug
		);
	});
	await sendAll(mails);
}

export async function withdrawResignation(m: Member, resignationId: string) {
	const id = z.uuid().safeParse(resignationId);
	if (!id.success) throw notFound();
	await withTenant(userCtx(m), async (tx) => {
		const gone = await tx
			.update(resignations)
			.set({ status: 'withdrawn', decidedByUserId: m.user.userId, decidedAt: new Date() })
			.where(
				and(
					eq(resignations.id, id.data),
					eq(resignations.requestedByUserId, m.user.userId),
					inArray(resignations.status, OPEN)
				)
			)
			.returning({ id: resignations.id });
		if (!gone.length) throw notFound();
	});
}

export async function ownResignation(tx: Tx, access: Access, employeeId: string) {
	if (access.employeeId !== employeeId) return null;
	const [row] = await tx
		.select({
			id: resignations.id,
			status: resignations.status,
			submittedOn: resignations.submittedOn,
			requestedLastDay: resignations.requestedLastDay
		})
		.from(resignations)
		.where(and(eq(resignations.employeeId, employeeId), inArray(resignations.status, OPEN)))
		.orderBy(desc(resignations.createdAt))
		.limit(1);
	return row ?? null;
}

export async function resignationApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	const scope = await resolveScope(tx, access, 'employee.delete');
	const asManager = access.employeeId
		? and(eq(resignations.status, 'pending_manager'), eq(employees.managerId, access.employeeId))
		: undefined;
	const asHr = and(
		or(
			eq(resignations.status, 'pending_hr'),
			and(eq(resignations.status, 'pending_manager'), isNull(employees.managerId))
		),
		scopeWhere(scope, resignations.employeeId)
	);
	const rows = await tx
		.select({ id: resignations.id, at: resignations.createdAt, name: employees.fullName, employeeId: employees.id })
		.from(resignations)
		.innerJoin(employees, eq(employees.id, resignations.employeeId))
		.where(asManager ? or(asManager, asHr) : asHr)
		.orderBy(asc(resignations.createdAt))
		.limit(200);
	return rows
		.filter((r) => r.employeeId !== access.employeeId)
		.map((r) => ({
			id: r.id,
			kind: 'Resignation',
			title: `${r.name} resigned`,
			requestedBy: r.name,
			at: r.at,
			link: `approvals/resignations/${r.id}`
		}));
}

type Stage = 'manager' | 'hr' | null;

async function stageFor(tx: Tx, access: Access, r: Resignation, e: { id: string; managerId: string | null }) {
	const hr = access.employeeId !== e.id && inScope(await resolveScope(tx, access, 'employee.delete'), e.id);
	const manager = !!access.employeeId && access.employeeId === e.managerId;
	const stage: Stage = !OPEN.includes(r.status as (typeof OPEN)[number])
		? null
		: r.status === 'pending_manager' && manager
			? 'manager'
			: hr
				? 'hr'
				: null;
	return { stage, visible: hr || manager };
}

async function load(tx: Tx, access: Access, resignationId: string, lock: boolean) {
	const id = z.uuid().safeParse(resignationId);
	if (!id.success) return null;
	const q = tx.select().from(resignations).where(eq(resignations.id, id.data));
	const [r] = lock ? await q.for('update') : await q;
	if (!r) return null;
	const [e] = await tx.select().from(employees).where(eq(employees.id, r.employeeId));
	const { stage, visible } = await stageFor(tx, access, r, e);
	return visible ? { r, e, stage } : null;
}

export async function getResignation(tx: Tx, access: Access, resignationId: string) {
	const found = await load(tx, access, resignationId, false);
	if (!found) return null;
	const { r, e, stage } = found;
	return {
		id: r.id,
		status: r.status,
		stage,
		employee: { id: e.id, code: e.code, fullName: e.fullName },
		submittedOn: r.submittedOn,
		noticeDays: r.noticeDays,
		noticeEnds: addDays(r.submittedOn, r.noticeDays),
		requestedLastDay: r.requestedLastDay,
		approvedLastDay: r.approvedLastDay,
		reason: r.reason,
		managerNote: r.managerNote,
		decisionNote: r.decisionNote
	};
}

const decisionSchema = z.object({
	decision: z.enum(['approve', 'reject']),
	note,
	lastDay: z.union([z.literal(''), z.iso.date('Enter the last working day.')]).optional()
});

export async function decideResignation(m: Member, resignationId: string, raw: Record<string, string>) {
	const input = decisionSchema.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		const found = await load(tx, m.access, resignationId, true);
		if (!found) throw notFound();
		const { r, stage } = found;
		if (!stage) {
			if (!OPEN.includes(r.status as (typeof OPEN)[number]))
				throw new AppError('already_decided', 'This resignation was already handled.', 409);
			throw new AppError('forbidden', 'You cannot decide on this resignation.', 403);
		}
		const out: Mail[] = [];
		const tell = async (title: string, body?: string) =>
			out.push(
				...(await notify(
					tx,
					m.tenant.id,
					await ownerMemberships(tx, r.employeeId),
					{ category: 'approvals', title, body, link: `employees/${r.employeeId}` },
					m.tenant.slug
				))
			);

		if (stage === 'manager') {
			const forward = input.decision === 'approve';
			await tx
				.update(resignations)
				.set({
					status: forward ? 'pending_hr' : 'rejected',
					managerUserId: m.user.userId,
					managerAt: new Date(),
					managerNote: input.note
				})
				.where(eq(resignations.id, r.id));
			if (forward)
				out.push(
					...(await notify(
						tx,
						m.tenant.id,
						await hrMemberships(tx),
						{
							category: 'approvals',
							title: `${found.e.fullName} has resigned`,
							body: `Their manager agreed. Requested last day: ${r.requestedLastDay}.`,
							link: `approvals/resignations/${r.id}`
						},
						m.tenant.slug
					))
				);
			else await tell('Your resignation was declined by your manager', input.note ?? undefined);
			return out;
		}

		if (input.decision === 'reject') {
			await tx
				.update(resignations)
				.set({ status: 'rejected', decidedByUserId: m.user.userId, decidedAt: new Date(), decisionNote: input.note })
				.where(eq(resignations.id, r.id));
			await tell('Your resignation was declined', input.note ?? undefined);
			return out;
		}

		const lastDay = input.lastDay || r.requestedLastDay;
		if (lastDay < r.submittedOn)
			throw new AppError('before_submitted', 'The last day cannot be before the resignation was submitted.', 400);
		const e = await lockEmployee(tx, m.access, r.employeeId);
		out.push(...(await applyExit(tx, m, e, { exitDate: lastDay, exitType: 'resignation', exitReason: r.reason })));
		await tx
			.update(resignations)
			.set({
				status: 'approved',
				decidedByUserId: m.user.userId,
				decidedAt: new Date(),
				decisionNote: input.note,
				approvedLastDay: lastDay
			})
			.where(eq(resignations.id, r.id));
		await tell(`Your resignation was accepted. Your last day is ${lastDay}`, input.note ?? undefined);
		return out;
	});
	await sendAll(mails);
}
