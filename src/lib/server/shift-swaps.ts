import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { moduleOn } from '../modules';
import type { ApprovalItem } from './approvals';
import { approvers, deciderWhere, rightsOver, singleAdmin } from './approval-chain';
import { recomputeAttendance } from './attendance';
import { addDays } from './dates';
import { authPool } from './db';
import { departments, employees, openShiftClaims, rosterEntries, shifts, shiftSwaps, tenants } from './db/schema';
import { lockEmployee } from './employees';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { advisoryLock, LOCK } from './locks';
import { log } from './log';
import type { Mail } from './mail';
import { moduleOverrides } from './modules';
import { notify, sendAll } from './notifications';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { resolveScope } from './rbac/scope';
import { activeShift, hhmm, isoDay, leaveDays, note, refuseClosed, refuseSwapping, tell, weekStart } from './schedule';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Employee = typeof employees.$inferSelect;
type Entry = typeof rosterEntries.$inferSelect;

const OPEN_SWAP = ['asked', 'accepted'];
const uuid = (v: unknown) => z.uuid().safeParse(v);
const choice = z.enum(['approve', 'reject'], { error: 'Choose approve or reject.' });

async function me(tx: Tx, m: Member) {
	if (!m.access.employeeId) throw new AppError('no_employee', 'Your account is not linked to an employee record.', 403);
	return lockEmployee(tx, m.access, m.access.employeeId);
}

async function colleague(tx: Tx, self: Employee, id: string) {
	const parsed = uuid(id);
	const [c] = parsed.success
		? await tx.select().from(employees).where(eq(employees.id, parsed.data)).for('update')
		: [];
	const near =
		c &&
		c.id !== self.id &&
		c.status !== 'exited' &&
		((!!c.departmentId && c.departmentId === self.departmentId) || (!!c.managerId && c.managerId === self.managerId));
	if (!near) throw new AppError('not_found', 'Choose a colleague from your team or department.', 404);
	return c;
}

const employed = (e: Employee, date: string) =>
	date >= e.joinDate && (e.exitDate ? date <= e.exitDate : e.status !== 'exited');

const clearOff = (tx: Tx, employeeId: string, date: string) =>
	tx
		.delete(rosterEntries)
		.where(and(eq(rosterEntries.employeeId, employeeId), eq(rosterEntries.date, date), eq(rosterEntries.kind, 'off')));

async function receives(tx: Tx, e: Employee, date: string, ignore: string[], who: string) {
	if (!employed(e, date)) throw new AppError('not_employed', `${who} is not employed on ${date}.`, 409);
	if ((await leaveDays(tx, [e.id], date, date)).size)
		throw new AppError('leave_conflict', `${who} is on leave on ${date}.`, 409);
	const [other] = await tx
		.select({ id: rosterEntries.id })
		.from(rosterEntries)
		.where(
			and(
				eq(rosterEntries.employeeId, e.id),
				eq(rosterEntries.date, date),
				eq(rosterEntries.kind, 'work'),
				ignore.length ? sql`${rosterEntries.id} not in ${ignore}` : undefined
			)
		)
		.limit(1);
	if (other) throw new AppError('busy', `${who} already has a schedule entry on ${date}.`, 409);
	await refuseClosed(tx, [{ employeeId: e.id, date }]);
}

async function future(tx: Tx, date: string) {
	if (date <= (await tenantToday(tx)))
		throw new AppError('too_late', 'Only days from tomorrow onwards can change hands.', 409);
}

async function publishedWork(tx: Tx, entryId: string, owner: string | null) {
	const parsed = uuid(entryId);
	const [entry] = parsed.success
		? await tx.select().from(rosterEntries).where(eq(rosterEntries.id, parsed.data)).for('update')
		: [];
	const ok =
		entry &&
		entry.status === 'published' &&
		entry.kind === 'work' &&
		(owner === null ? entry.employeeId === null : entry.employeeId === owner);
	if (!ok) throw new AppError('not_found', 'That shift is not on the published schedule.', 404);
	return entry;
}

const label = async (tx: Tx, e: Entry) => {
	const [s] = await tx.select().from(shifts).where(eq(shifts.id, e.shiftId!));
	return `${e.date} ${s ? `${s.name} ${hhmm(s.startTime)}–${hhmm(s.endTime)}` : ''}`.trim();
};

async function tellPeople(tx: Tx, m: Member, membershipIds: string[], title: string, date: string) {
	if (!membershipIds.length) return [];
	const { start } = await weekStart(tx, date);
	return notify(
		tx,
		m.tenant.id,
		[...new Set(membershipIds)],
		{ category: 'schedule', title, link: `schedule?week=${start}` },
		m.tenant.slug
	);
}

const tellStaff = async (tx: Tx, m: Member, employeeIds: string[], title: string, date: string) =>
	tell(tx, m, employeeIds, title, (await weekStart(tx, date)).start);

const openShiftSchema = z.object({
	date: isoDay('Choose a day.'),
	shiftId: z.uuid({ error: 'Choose a shift.' }),
	note
});

export async function postOpenShift(m: Member, raw: Record<string, string>) {
	const input = openShiftSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const manage = await resolveScope(tx, m.access, 'schedule.manage');
		if (manage.kind === 'ids' && !manage.ids.length)
			throw new AppError('forbidden', 'You cannot post open shifts.', 403);
		await future(tx, input.date);
		const shift = await activeShift(tx, input.shiftId);
		await tx.insert(rosterEntries).values({
			tenantId: m.tenant.id,
			employeeId: null,
			date: input.date,
			kind: 'work',
			shiftId: shift!.id,
			note: input.note,
			status: 'published',
			publishedAt: new Date(),
			createdByUserId: m.user.userId
		});
	});
}

export async function removeOpenShift(m: Member, entryId: string) {
	const mails = await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const entry = await publishedWork(tx, entryId, null);
		const manage = await resolveScope(tx, m.access, 'schedule.manage');
		const mine = entry.createdByUserId === m.user.userId && (manage.kind === 'all' || manage.ids.length > 0);
		if (!mine && manage.kind !== 'all')
			throw new AppError('forbidden', 'Only the person who posted this open shift can remove it.', 403);
		const waiting = await tx
			.select({ employeeId: openShiftClaims.employeeId })
			.from(openShiftClaims)
			.where(and(eq(openShiftClaims.rosterEntryId, entry.id), eq(openShiftClaims.status, 'pending')));
		const what = await label(tx, entry);
		await tx.delete(rosterEntries).where(eq(rosterEntries.id, entry.id));
		return tellStaff(
			tx,
			m,
			waiting.map((w) => w.employeeId),
			`The open shift on ${what} was withdrawn`,
			entry.date
		);
	});
	await sendAll(mails);
}

export async function claimOpenShift(m: Member, entryId: string) {
	const mails = await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const self = await me(tx, m);
		const entry = await publishedWork(tx, entryId, null);
		await future(tx, entry.date);
		await receives(tx, self, entry.date, [], 'You');
		const [claim] = await tx
			.insert(openShiftClaims)
			.values({ tenantId: m.tenant.id, rosterEntryId: entry.id, employeeId: self.id })
			.onConflictDoUpdate({
				target: [openShiftClaims.tenantId, openShiftClaims.rosterEntryId, openShiftClaims.employeeId],
				set: { status: 'pending', decidedByUserId: null, decidedAt: null },
				setWhere: sql`${openShiftClaims.status} = 'withdrawn'`
			})
			.returning({ id: openShiftClaims.id });
		if (!claim)
			throw new AppError('already_claimed', 'You already asked for this shift, or your request was turned down.', 409);
		return tellPeople(
			tx,
			m,
			await approvers(tx, self, 'schedule'),
			`${self.fullName} asks for the open shift on ${await label(tx, entry)}`,
			entry.date
		);
	});
	await sendAll(mails);
}

export async function withdrawClaim(m: Member, claimId: string) {
	await withTenant(userCtx(m), async (tx) => {
		const id = uuid(claimId);
		const gone =
			id.success && m.access.employeeId
				? await tx
						.update(openShiftClaims)
						.set({ status: 'withdrawn' })
						.where(
							and(
								eq(openShiftClaims.id, id.data),
								eq(openShiftClaims.employeeId, m.access.employeeId),
								eq(openShiftClaims.status, 'pending')
							)
						)
						.returning({ id: openShiftClaims.id })
				: [];
		if (!gone.length) throw new AppError('not_found', 'That request does not exist.', 404);
	});
}

export async function decideClaim(m: Member, claimId: string, raw: string) {
	const decision = choice.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const id = uuid(claimId);
		const [claim] = id.success
			? await tx.select().from(openShiftClaims).where(eq(openShiftClaims.id, id.data)).for('update')
			: [];
		if (!claim || claim.status !== 'pending') throw new AppError('not_found', 'That request is no longer open.', 404);
		const [claimant] = await tx.select().from(employees).where(eq(employees.id, claim.employeeId)).for('update');
		if (!(await rightsOver(tx, m.access, claimant, 'schedule')).canDecide)
			throw new AppError('forbidden', 'You cannot decide this request.', 403);
		const entry = await publishedWork(tx, claim.rosterEntryId, null);
		const decided = { decidedByUserId: m.user.userId, decidedAt: new Date() };
		const what = await label(tx, entry);
		if (decision === 'reject') {
			await tx
				.update(openShiftClaims)
				.set({ status: 'rejected', ...decided })
				.where(eq(openShiftClaims.id, claim.id));
			return tellStaff(tx, m, [claimant.id], `Your request for ${what} was declined`, entry.date);
		}
		await future(tx, entry.date);
		await receives(tx, claimant, entry.date, [], claimant.fullName);
		await clearOff(tx, claimant.id, entry.date);
		await tx.update(rosterEntries).set({ employeeId: claimant.id }).where(eq(rosterEntries.id, entry.id));
		await tx
			.update(openShiftClaims)
			.set({ status: 'approved', ...decided })
			.where(eq(openShiftClaims.id, claim.id));
		const others = await tx
			.update(openShiftClaims)
			.set({ status: 'rejected', ...decided })
			.where(and(eq(openShiftClaims.rosterEntryId, entry.id), eq(openShiftClaims.status, 'pending')))
			.returning({ employeeId: openShiftClaims.employeeId });
		await recomputeAttendance(tx, m.tenant.id, entry.date, entry.date, [claimant.id]);
		return [
			...(await tellStaff(tx, m, [claimant.id], `You have the shift on ${what}`, entry.date)),
			...(others.length
				? await tellStaff(
						tx,
						m,
						others.map((o) => o.employeeId),
						`The open shift on ${what} went to someone else`,
						entry.date
					)
				: [])
		];
	});
	await sendAll(mails);
}

const swapSchema = z.object({
	entryId: z.uuid({ error: 'Choose your shift.' }),
	counterpartId: z.uuid({ error: 'Choose a colleague.' }),
	counterpartEntryId: z
		.string()
		.optional()
		.transform((v) => v || null)
		.refine((v) => v === null || uuid(v).success, 'Choose one of their shifts.'),
	note
});

async function checkSwap(
	tx: Tx,
	requester: Employee,
	counterpart: Employee,
	give: Entry,
	take: Entry | null,
	who: { requester: string; counterpart: string }
) {
	await future(tx, give.date);
	if (take) {
		await future(tx, take.date);
		await receives(tx, requester, take.date, take.date === give.date ? [give.id] : [], who.requester);
	}
	await receives(tx, counterpart, give.date, take && take.date === give.date ? [take.id] : [], who.counterpart);
	await refuseClosed(tx, [
		{ employeeId: requester.id, date: give.date },
		...(take ? [{ employeeId: counterpart.id, date: take.date }] : [])
	]);
}

export async function requestSwap(m: Member, raw: Record<string, string>) {
	const input = swapSchema.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const self = await me(tx, m);
		const other = await colleague(tx, self, input.counterpartId);
		const give = await publishedWork(tx, input.entryId, self.id);
		const take = input.counterpartEntryId ? await publishedWork(tx, input.counterpartEntryId, other.id) : null;
		await refuseSwapping(tx, [give.id, ...(take ? [take.id] : [])]);
		await checkSwap(tx, self, other, give, take, { requester: 'You', counterpart: other.fullName });
		await tx.insert(shiftSwaps).values({
			tenantId: m.tenant.id,
			requesterId: self.id,
			requesterEntryId: give.id,
			counterpartId: other.id,
			counterpartEntryId: take?.id ?? null,
			note: input.note
		});
		const title = take
			? `${self.fullName} asks to swap ${await label(tx, give)} for your ${await label(tx, take)}`
			: `${self.fullName} asks you to take ${await label(tx, give)}`;
		return tellStaff(tx, m, [other.id], title, give.date);
	});
	await sendAll(mails);
}

async function loadSwap(tx: Tx, swapId: string) {
	const id = uuid(swapId);
	const [swap] = id.success ? await tx.select().from(shiftSwaps).where(eq(shiftSwaps.id, id.data)).for('update') : [];
	if (!swap) throw new AppError('not_found', 'That swap does not exist.', 404);
	const people = await tx
		.select()
		.from(employees)
		.where(inArray(employees.id, [swap.requesterId, swap.counterpartId]))
		.for('update');
	const requester = people.find((p) => p.id === swap.requesterId)!;
	const counterpart = people.find((p) => p.id === swap.counterpartId)!;
	return { swap, requester, counterpart };
}

export async function answerSwap(m: Member, swapId: string, raw: string) {
	const accept = z.enum(['accept', 'decline'], { error: 'Choose accept or decline.' }).parse(raw) === 'accept';
	const mails = await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const { swap, requester, counterpart } = await loadSwap(tx, swapId);
		if (swap.counterpartId !== m.access.employeeId || swap.status !== 'asked')
			throw new AppError('not_found', 'That swap is not waiting for you.', 404);
		const give = await publishedWork(tx, swap.requesterEntryId, requester.id);
		if (!accept) {
			await tx.update(shiftSwaps).set({ status: 'declined' }).where(eq(shiftSwaps.id, swap.id));
			return tellStaff(tx, m, [requester.id], `${counterpart.fullName} declined your swap for ${give.date}`, give.date);
		}
		const take = swap.counterpartEntryId ? await publishedWork(tx, swap.counterpartEntryId, counterpart.id) : null;
		await checkSwap(tx, requester, counterpart, give, take, {
			requester: requester.fullName,
			counterpart: 'You'
		});
		await tx.update(shiftSwaps).set({ status: 'accepted' }).where(eq(shiftSwaps.id, swap.id));
		const deciders = [
			...(await approvers(tx, requester, 'schedule')),
			...(await approvers(tx, counterpart, 'schedule'))
		];
		return tellPeople(
			tx,
			m,
			deciders,
			`Swap to approve: ${requester.fullName} and ${counterpart.fullName} on ${give.date}`,
			give.date
		);
	});
	await sendAll(mails);
}

export async function cancelSwap(m: Member, swapId: string) {
	await withTenant(userCtx(m), async (tx) => {
		const { swap } = await loadSwap(tx, swapId);
		if (swap.requesterId !== m.access.employeeId || !OPEN_SWAP.includes(swap.status))
			throw new AppError('not_found', 'That swap can no longer be cancelled.', 404);
		await tx.update(shiftSwaps).set({ status: 'cancelled' }).where(eq(shiftSwaps.id, swap.id));
	});
}

async function applySwap(
	tx: Tx,
	m: Member,
	swap: typeof shiftSwaps.$inferSelect,
	requester: Employee,
	counterpart: Employee
) {
	const give = await publishedWork(tx, swap.requesterEntryId, requester.id);
	const take = swap.counterpartEntryId ? await publishedWork(tx, swap.counterpartEntryId, counterpart.id) : null;
	await checkSwap(tx, requester, counterpart, give, take, {
		requester: requester.fullName,
		counterpart: counterpart.fullName
	});
	await clearOff(tx, counterpart.id, give.date);
	if (take) await clearOff(tx, requester.id, take.date);
	await tx.update(rosterEntries).set({ employeeId: null }).where(eq(rosterEntries.id, give.id));
	if (take) await tx.update(rosterEntries).set({ employeeId: requester.id }).where(eq(rosterEntries.id, take.id));
	await tx.update(rosterEntries).set({ employeeId: counterpart.id }).where(eq(rosterEntries.id, give.id));
	const rest = (employeeId: string, date: string) => ({
		tenantId: m.tenant.id,
		employeeId,
		date,
		kind: 'off',
		shiftId: null,
		status: 'published',
		publishedAt: new Date(),
		note: 'Swapped away',
		createdByUserId: m.user.userId
	});
	const offs = [
		...((!take || take.date !== give.date) && employed(requester, give.date) ? [rest(requester.id, give.date)] : []),
		...(take && take.date !== give.date && employed(counterpart, take.date) ? [rest(counterpart.id, take.date)] : [])
	];
	if (offs.length) await tx.insert(rosterEntries).values(offs);
	const dates = [give.date, ...(take ? [take.date] : [])].sort();
	await recomputeAttendance(tx, m.tenant.id, dates[0], dates[dates.length - 1], [requester.id, counterpart.id]);
	return give.date;
}

export async function decideSwap(m: Member, swapId: string, raw: string) {
	const decision = choice.parse(raw);
	const result = await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const { swap, requester, counterpart } = await loadSwap(tx, swapId);
		if (swap.status !== 'accepted') throw new AppError('not_found', 'That swap is not waiting for approval.', 404);
		const party = [requester.id, counterpart.id].includes(m.access.employeeId ?? '');
		const allowed = !party || (await singleAdmin(tx));
		const forRequester =
			allowed && !swap.requesterApprovedByUserId && (await rightsOver(tx, m.access, requester, 'schedule')).canDecide;
		const forCounterpart =
			allowed &&
			!swap.counterpartApprovedByUserId &&
			(await rightsOver(tx, m.access, counterpart, 'schedule')).canDecide;
		if (!forRequester && !forCounterpart) throw new AppError('forbidden', 'You cannot decide this swap.', 403);
		const [give] = await tx.select().from(rosterEntries).where(eq(rosterEntries.id, swap.requesterEntryId));
		const both = [requester.id, counterpart.id];
		const decided = { decidedByUserId: m.user.userId, decidedAt: new Date() };
		if (decision === 'reject') {
			await tx
				.update(shiftSwaps)
				.set({ status: 'rejected', ...decided })
				.where(eq(shiftSwaps.id, swap.id));
			return {
				status: 'rejected',
				mails: await tellStaff(tx, m, both, `Your swap on ${give.date} was not approved`, give.date)
			};
		}
		const slots = {
			requesterApprovedByUserId: swap.requesterApprovedByUserId ?? (forRequester ? m.user.userId : null),
			counterpartApprovedByUserId: swap.counterpartApprovedByUserId ?? (forCounterpart ? m.user.userId : null)
		};
		if (!slots.requesterApprovedByUserId || !slots.counterpartApprovedByUserId) {
			await tx.update(shiftSwaps).set(slots).where(eq(shiftSwaps.id, swap.id));
			return { status: 'accepted', mails: [] as Mail[] };
		}
		const date = await applySwap(tx, m, swap, requester, counterpart);
		await tx
			.update(shiftSwaps)
			.set({ ...slots, status: 'approved', ...decided })
			.where(eq(shiftSwaps.id, swap.id));
		return { status: 'approved', mails: await tellStaff(tx, m, both, `Your swap on ${date} is approved`, date) };
	});
	await sendAll(result.mails);
	return result.status;
}

const requesterPerson = alias(employees, 'requester');
const counterpartPerson = alias(employees, 'counterpart');
const takeEntry = alias(rosterEntries, 'take_entry');
const takeShift = alias(shifts, 'take_shift');

export async function myShiftTrades(tx: Tx, access: Access) {
	const meId = access.employeeId;
	const today = await tenantToday(tx);
	const swaps = meId
		? await tx
				.select({
					swap: shiftSwaps,
					requester: requesterPerson.fullName,
					counterpart: counterpartPerson.fullName,
					date: rosterEntries.date
				})
				.from(shiftSwaps)
				.innerJoin(requesterPerson, eq(requesterPerson.id, shiftSwaps.requesterId))
				.innerJoin(counterpartPerson, eq(counterpartPerson.id, shiftSwaps.counterpartId))
				.innerJoin(rosterEntries, eq(rosterEntries.id, shiftSwaps.requesterEntryId))
				.where(
					and(
						or(eq(shiftSwaps.requesterId, meId), eq(shiftSwaps.counterpartId, meId)),
						gt(rosterEntries.date, addDays(today, -14))
					)
				)
				.orderBy(asc(rosterEntries.date))
				.limit(100)
		: [];
	const claims = meId
		? await tx
				.select({ claim: openShiftClaims, date: rosterEntries.date })
				.from(openShiftClaims)
				.innerJoin(rosterEntries, eq(rosterEntries.id, openShiftClaims.rosterEntryId))
				.where(and(eq(openShiftClaims.employeeId, meId), gt(rosterEntries.date, today)))
				.orderBy(asc(rosterEntries.date))
				.limit(100)
		: [];
	return {
		swaps: swaps.map((s) => ({
			id: s.swap.id,
			date: s.date,
			status: s.swap.status,
			mine: s.swap.requesterId === meId,
			requester: s.requester,
			counterpart: s.counterpart,
			giveAway: !s.swap.counterpartEntryId
		})),
		claims: claims.map((c) => ({
			id: c.claim.id,
			entryId: c.claim.rosterEntryId,
			date: c.date,
			status: c.claim.status
		}))
	};
}

async function swapRowsToDecide(tx: Tx, access: Access, side: 'requester' | 'counterpart') {
	const person = side === 'requester' ? shiftSwaps.requesterId : shiftSwaps.counterpartId;
	const slot = side === 'requester' ? shiftSwaps.requesterApprovedByUserId : shiftSwaps.counterpartApprovedByUserId;
	return tx
		.select({ swap: shiftSwaps, name: employees.fullName, employeeId: employees.id })
		.from(shiftSwaps)
		.innerJoin(employees, eq(employees.id, person))
		.leftJoin(departments, eq(departments.id, employees.departmentId))
		.where(and(eq(shiftSwaps.status, 'accepted'), isNull(slot), await deciderWhere(tx, access, 'schedule')))
		.orderBy(asc(shiftSwaps.createdAt))
		.limit(200);
}

export async function scheduleApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	if (!moduleOn(await moduleOverrides(tx), 'schedule')) return [];
	const meId = access.employeeId;
	const today = await tenantToday(tx);
	const [a, b, claims] = await Promise.all([
		swapRowsToDecide(tx, access, 'requester'),
		swapRowsToDecide(tx, access, 'counterpart'),
		tx
			.select({ claim: openShiftClaims, name: employees.fullName, date: rosterEntries.date })
			.from(openShiftClaims)
			.innerJoin(employees, eq(employees.id, openShiftClaims.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.innerJoin(rosterEntries, eq(rosterEntries.id, openShiftClaims.rosterEntryId))
			.where(
				and(
					eq(openShiftClaims.status, 'pending'),
					gt(rosterEntries.date, today),
					await deciderWhere(tx, access, 'schedule')
				)
			)
			.orderBy(asc(openShiftClaims.createdAt))
			.limit(200)
	]);
	const inSwap = (r: (typeof a)[number]) => r.swap.requesterId === meId || r.swap.counterpartId === meId;
	const mineToo = [...a, ...b].some(inSwap) || claims.some((r) => r.claim.employeeId === meId);
	const single = mineToo && (await singleAdmin(tx));
	const swaps = new Map([...a, ...b].filter((r) => !inSwap(r) || single).map((r) => [r.swap.id, r] as const));
	return [
		...[...swaps.values()].map(({ swap, name }) => ({
			id: swap.id,
			kind: 'Shift swap',
			title: `${name}: shift swap`,
			requestedBy: name,
			at: swap.createdAt,
			link: 'schedule#trades'
		})),
		...claims
			.filter(({ claim }) => claim.employeeId !== meId || single)
			.map(({ claim, name, date }) => ({
				id: claim.id,
				kind: 'Open shift',
				title: `${name}: open shift on ${date}`,
				requestedBy: name,
				at: claim.createdAt,
				link: `schedule?week=${date}#trades`
			}))
	];
}

export async function tradesToDecide(tx: Tx, access: Access) {
	const items = await scheduleApprovals(tx, access);
	const swapIds = items.filter((i) => i.kind === 'Shift swap').map((i) => i.id);
	const claimIds = items.filter((i) => i.kind === 'Open shift').map((i) => i.id);
	const swaps = swapIds.length
		? await tx
				.select({
					id: shiftSwaps.id,
					requester: requesterPerson.fullName,
					counterpart: counterpartPerson.fullName,
					date: rosterEntries.date,
					shift: shifts.name,
					takeDate: takeEntry.date,
					takeShift: takeShift.name,
					giveAway: sql<boolean>`${shiftSwaps.counterpartEntryId} is null`
				})
				.from(shiftSwaps)
				.innerJoin(requesterPerson, eq(requesterPerson.id, shiftSwaps.requesterId))
				.innerJoin(counterpartPerson, eq(counterpartPerson.id, shiftSwaps.counterpartId))
				.innerJoin(rosterEntries, eq(rosterEntries.id, shiftSwaps.requesterEntryId))
				.innerJoin(shifts, eq(shifts.id, rosterEntries.shiftId))
				.leftJoin(takeEntry, eq(takeEntry.id, shiftSwaps.counterpartEntryId))
				.leftJoin(takeShift, eq(takeShift.id, takeEntry.shiftId))
				.where(inArray(shiftSwaps.id, swapIds))
		: [];
	const claims = claimIds.length
		? await tx
				.select({ id: openShiftClaims.id, name: employees.fullName, date: rosterEntries.date })
				.from(openShiftClaims)
				.innerJoin(employees, eq(employees.id, openShiftClaims.employeeId))
				.innerJoin(rosterEntries, eq(rosterEntries.id, openShiftClaims.rosterEntryId))
				.where(inArray(openShiftClaims.id, claimIds))
		: [];
	return { swaps, claims };
}

export async function swapOptions(tx: Tx, access: Access, from: string, to: string) {
	if (!access.employeeId) return [];
	const [self] = await tx.select().from(employees).where(eq(employees.id, access.employeeId));
	if (!self || (!self.departmentId && !self.managerId)) return [];
	const people = await tx
		.select({ id: employees.id, name: employees.fullName })
		.from(employees)
		.where(
			and(
				ne(employees.id, self.id),
				ne(employees.status, 'exited'),
				or(
					self.departmentId ? eq(employees.departmentId, self.departmentId) : undefined,
					self.managerId ? eq(employees.managerId, self.managerId) : undefined
				)
			)
		)
		.orderBy(asc(employees.fullName))
		.limit(200);
	const entries = people.length
		? await tx
				.select({ id: rosterEntries.id, employeeId: rosterEntries.employeeId, date: rosterEntries.date })
				.from(rosterEntries)
				.where(
					and(
						inArray(
							rosterEntries.employeeId,
							people.map((p) => p.id)
						),
						eq(rosterEntries.status, 'published'),
						eq(rosterEntries.kind, 'work'),
						gt(rosterEntries.date, await tenantToday(tx)),
						sql`${rosterEntries.date} between ${from} and ${to}`
					)
				)
				.orderBy(asc(rosterEntries.date))
		: [];
	return people.map((p) => ({ ...p, entries: entries.filter((e) => e.employeeId === p.id) }));
}

export async function openShiftsIn(tx: Tx, access: Access, userId: string, from: string, to: string) {
	const meId = access.employeeId;
	const manage = await resolveScope(tx, access, 'schedule.manage');
	const rows = await tx
		.select({ entry: rosterEntries, shift: shifts })
		.from(rosterEntries)
		.innerJoin(shifts, eq(shifts.id, rosterEntries.shiftId))
		.where(
			and(
				isNull(rosterEntries.employeeId),
				eq(rosterEntries.status, 'published'),
				sql`${rosterEntries.date} between ${from} and ${to}`
			)
		)
		.orderBy(asc(rosterEntries.date), asc(shifts.startTime));
	const claims = rows.length
		? await tx
				.select({
					entryId: openShiftClaims.rosterEntryId,
					employeeId: openShiftClaims.employeeId,
					status: openShiftClaims.status
				})
				.from(openShiftClaims)
				.where(
					and(
						inArray(
							openShiftClaims.rosterEntryId,
							rows.map((r) => r.entry.id)
						),
						eq(openShiftClaims.status, 'pending')
					)
				)
		: [];
	const today = await tenantToday(tx);
	return rows.map(({ entry, shift }) => ({
		id: entry.id,
		date: entry.date,
		shift: `${shift.name} ${hhmm(shift.startTime)}–${hhmm(shift.endTime)}`,
		note: entry.note,
		claims: claims.filter((c) => c.entryId === entry.id).length,
		claimed: claims.some((c) => c.entryId === entry.id && c.employeeId === meId),
		canClaim: !!meId && entry.date > today,
		canRemove: manage.kind === 'all' || (entry.createdByUserId === userId && manage.ids.length > 0)
	}));
}

export async function expireSwaps() {
	const list = await authPool().db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
	await list.reduce<Promise<void>>((prior, t) => prior.then(() => expireFor(t.id)), Promise.resolve());
}

async function expireFor(tenantId: string) {
	await withTenant(systemCtx(tenantId), async (tx) => {
		const today = await tenantToday(tx);
		await tx
			.update(shiftSwaps)
			.set({ status: 'expired' })
			.where(
				and(
					inArray(shiftSwaps.status, OPEN_SWAP),
					sql`exists (select 1 from roster_entries r where r.tenant_id = ${shiftSwaps.tenantId}
							and r.id in (${shiftSwaps.requesterEntryId}, ${shiftSwaps.counterpartEntryId}) and r.date <= ${today})`
				)
			);
	}).catch((err) => log.error({ tenantId, err: (err as Error).message }, 'swap expiry failed'));
}
