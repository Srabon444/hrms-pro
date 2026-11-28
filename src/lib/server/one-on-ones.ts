import { and, asc, desc, eq, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { activeMemberships } from './approval-chain';
import { requireActiveMember } from './audience';
import { employees, oneOnOneItems, oneOnOnePrivateNotes, oneOnOnes } from './db/schema';
import { AppError } from './errors';
import type { Mail } from './mail';
import { notify, sendAll } from './notifications';
import { hitOrLocal } from './ratelimit';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const ONE_ON_ONE_LIST_SIZE = 100;
export const ONE_ON_ONES_PER_DAY = 20;
export const ONE_ON_ONE_EDITS_PER_MINUTE = 60;
const MEETABLE = ['probation', 'active', 'notice'];
const NUL = 'Remove unsupported characters.';
const noNul = (v: string) => !v.includes('\0');

const notFound = () => new AppError('not_found', 'That 1:1 does not exist.', 404);
const meetingId = z.uuid({ error: 'Choose a 1:1.' });

const scheduleSchema = z.object({
	employeeId: z.uuid('Choose who to meet.'),
	scheduledFor: z.iso.date('Choose a date.').refine((v) => v >= '2000-01-01' && v <= '2100-12-31', 'Choose a date.')
});

const itemSchema = z.object({
	kind: z.enum(['agenda', 'action'], 'Choose agenda or action.'),
	text: z
		.string('Write the item.')
		.trim()
		.min(1, 'Write the item.')
		.max(500, 'Keep the item under 500 characters.')
		.refine(noNul, NUL),
	ownerEmployeeId: z
		.union([z.literal(''), z.uuid('Choose who owns the action.')])
		.transform((v) => v || null)
		.prefault('')
});

const noteSchema = z.string().trim().max(4000, 'Keep the note under 4000 characters.').refine(noNul, NUL).prefault('');

const people = (tx: Tx, ids: string[]) =>
	tx
		.select({ id: employees.id, name: employees.fullName, managerId: employees.managerId, status: employees.status })
		.from(employees)
		.where(inArray(employees.id, ids));

const limit = async (m: Member, bucket: string, max: number, windowMs: number) => {
	const r = await hitOrLocal(bucket, m.access.membershipId, max, windowMs);
	if (!r.ok) throw new AppError('too_many', 'You are doing that too often. Wait a little and try again.', 429);
};

const reportsOf = (tx: Tx, me: string) =>
	tx.select({ id: employees.id }).from(employees).where(eq(employees.managerId, me));

const listFields = {
	id: oneOnOnes.id,
	scheduledFor: oneOnOnes.scheduledFor,
	status: oneOnOnes.status,
	managerEmployeeId: oneOnOnes.managerEmployeeId,
	employeeId: oneOnOnes.employeeId
};

async function named<T extends { managerEmployeeId: string; employeeId: string }>(tx: Tx, rows: T[]) {
	const ids = [...new Set(rows.flatMap((r) => [r.managerEmployeeId, r.employeeId]))];
	const names = new Map((ids.length ? await people(tx, ids) : []).map((p) => [p.id, p.name]));
	return rows.map((r) => ({
		...r,
		managerName: names.get(r.managerEmployeeId) ?? '',
		employeeName: names.get(r.employeeId) ?? ''
	}));
}

export async function oneOnOnesHome(tx: Tx, access: Access) {
	const me = access.employeeId;
	const hr = await resolveScope(tx, access, 'performance.manage');
	const mine = me
		? await tx
				.select(listFields)
				.from(oneOnOnes)
				.where(or(eq(oneOnOnes.employeeId, me), inArray(oneOnOnes.employeeId, reportsOf(tx, me))))
				.orderBy(desc(oneOnOnes.scheduledFor), desc(oneOnOnes.createdAt))
				.limit(ONE_ON_ONE_LIST_SIZE)
		: [];
	const others =
		hr.kind === 'all' || hr.ids.length
			? await tx
					.select(listFields)
					.from(oneOnOnes)
					.where(
						and(
							scopeWhere(hr, oneOnOnes.employeeId),
							me ? and(ne(oneOnOnes.employeeId, me), notInArray(oneOnOnes.employeeId, reportsOf(tx, me))) : undefined
						)
					)
					.orderBy(desc(oneOnOnes.scheduledFor), desc(oneOnOnes.createdAt))
					.limit(ONE_ON_ONE_LIST_SIZE)
			: [];
	const [self] = me ? await people(tx, [me]) : [];
	const reports = me
		? await tx
				.select({ id: employees.id, name: employees.fullName })
				.from(employees)
				.where(and(eq(employees.managerId, me), inArray(employees.status, MEETABLE)))
				.orderBy(asc(employees.fullName))
		: [];
	const [manager] = self?.managerId ? await people(tx, [self.managerId]) : [];
	return {
		mine: await named(tx, mine),
		others: await named(tx, others),
		reports,
		myManager: manager && MEETABLE.includes(manager.status) ? { id: manager.id, name: manager.name } : null,
		me
	};
}

export async function scheduleOneOnOne(m: Member, raw: Record<string, string>) {
	const input = scheduleSchema.parse(raw);
	const me = m.access.employeeId;
	if (!me) throw new AppError('forbidden', 'Only employees can schedule a 1:1.', 403);
	let mails: Mail[] = [];
	const id = await withTenant(userCtx(m), async (tx) => {
		await requireActiveMember(tx, m.access.membershipId);
		const [target] = await people(tx, [input.employeeId]);
		if (!target || !MEETABLE.includes(target.status))
			throw new AppError('invalid_person', 'Choose someone from the list.', 400);
		const managerId = target.id === me ? target.managerId : me;
		if (!managerId) throw new AppError('no_manager', 'You have no manager to meet yet.', 400);
		if (target.id !== me && target.managerId !== me)
			throw new AppError(
				'invalid_person',
				'You can only schedule a 1:1 with your manager or your direct reports.',
				400
			);
		const [manager] = await people(tx, [managerId]);
		if (!manager || !MEETABLE.includes(manager.status))
			throw new AppError('no_manager', 'You have no manager to meet yet.', 400);
		await limit(m, 'one_on_one', ONE_ON_ONES_PER_DAY, 86_400_000);
		const [row] = await tx
			.insert(oneOnOnes)
			.values({
				tenantId: m.tenant.id,
				managerEmployeeId: managerId,
				employeeId: target.id,
				scheduledFor: input.scheduledFor
			})
			.returning({ id: oneOnOnes.id });
		const other = managerId === me ? target.id : managerId;
		const [self] = await people(tx, [me]);
		mails = await notify(
			tx,
			m.tenant.id,
			await activeMemberships(tx, other),
			{
				category: 'one_on_ones',
				title: `${self?.name ?? 'Someone'} scheduled a 1:1 with you on ${input.scheduledFor}`,
				link: `one-on-ones/${row.id}`
			},
			m.tenant.slug
		);
		return row.id;
	});
	await sendAll(mails);
	return id;
}

async function meetingFor(tx: Tx, access: Access, id: string, lock = false) {
	const mid = meetingId.safeParse(id);
	if (!mid.success) return null;
	const q = tx
		.select({ meeting: oneOnOnes, currentManagerId: employees.managerId })
		.from(oneOnOnes)
		.innerJoin(employees, eq(employees.id, oneOnOnes.employeeId))
		.where(eq(oneOnOnes.id, mid.data));
	const [row] = await (lock ? q.for('update', { of: oneOnOnes }) : q);
	if (!row) return null;
	const mt = row.meeting;
	const me = access.employeeId;
	const participant = !!me && (me === mt.employeeId || me === row.currentManagerId);
	const hr = !participant && inScope(await resolveScope(tx, access, 'performance.manage'), mt.employeeId);
	if (!participant && !hr) return null;
	return { ...mt, participant };
}

async function participantOf(tx: Tx, m: Member, id: string) {
	await requireActiveMember(tx, m.access.membershipId);
	const mt = await meetingFor(tx, m.access, id, true);
	if (!mt) throw notFound();
	if (!mt.participant)
		throw new AppError('forbidden', 'Only the employee and their current manager can change this 1:1.', 403);
	return mt;
}

export async function meetingPage(tx: Tx, access: Access, id: string) {
	const mt = await meetingFor(tx, access, id);
	if (!mt) return null;
	const pair = and(eq(oneOnOnes.employeeId, mt.employeeId), ne(oneOnOnes.status, 'cancelled'));
	const [items, carried, note, names] = await Promise.all([
		tx
			.select()
			.from(oneOnOneItems)
			.where(eq(oneOnOneItems.meetingId, mt.id))
			.orderBy(asc(oneOnOneItems.createdAt), asc(oneOnOneItems.id)),
		tx
			.select({
				id: oneOnOneItems.id,
				text: oneOnOneItems.text,
				ownerEmployeeId: oneOnOneItems.ownerEmployeeId,
				scheduledFor: oneOnOnes.scheduledFor
			})
			.from(oneOnOneItems)
			.innerJoin(oneOnOnes, eq(oneOnOnes.id, oneOnOneItems.meetingId))
			.where(
				and(
					pair,
					ne(oneOnOnes.id, mt.id),
					lte(oneOnOnes.scheduledFor, mt.scheduledFor),
					eq(oneOnOneItems.kind, 'action'),
					isNull(oneOnOneItems.doneAt)
				)
			)
			.orderBy(asc(oneOnOnes.scheduledFor), asc(oneOnOneItems.createdAt)),
		mt.participant
			? tx
					.select({ text: oneOnOnePrivateNotes.text })
					.from(oneOnOnePrivateNotes)
					.where(
						and(
							eq(oneOnOnePrivateNotes.meetingId, mt.id),
							eq(oneOnOnePrivateNotes.authorMembershipId, access.membershipId)
						)
					)
			: Promise.resolve([]),
		people(tx, [mt.managerEmployeeId, mt.employeeId])
	]);
	const name = new Map(names.map((p) => [p.id, p.name]));
	const owner = (id: string | null) => (id ? (name.get(id) ?? '') : '');
	return {
		meeting: {
			id: mt.id,
			scheduledFor: mt.scheduledFor,
			status: mt.status,
			managerEmployeeId: mt.managerEmployeeId,
			employeeId: mt.employeeId,
			managerName: name.get(mt.managerEmployeeId) ?? '',
			employeeName: name.get(mt.employeeId) ?? ''
		},
		participant: mt.participant,
		canEdit: mt.participant && mt.status !== 'cancelled',
		items: items.map((i) => ({
			id: i.id,
			kind: i.kind,
			text: i.text,
			owner: owner(i.ownerEmployeeId),
			done: !!i.doneAt
		})),
		carried: carried.map((i) => ({ id: i.id, text: i.text, owner: owner(i.ownerEmployeeId), from: i.scheduledFor })),
		privateNote: mt.participant ? (note[0]?.text ?? '') : null
	};
}

export async function addItem(m: Member, id: string, raw: Record<string, string>) {
	const input = itemSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const mt = await participantOf(tx, m, id);
		if (mt.status === 'cancelled') throw new AppError('cancelled', 'This 1:1 was cancelled.', 409);
		const owner = input.kind === 'action' ? input.ownerEmployeeId : null;
		if (owner && owner !== mt.managerEmployeeId && owner !== mt.employeeId)
			throw new AppError('invalid_owner', 'An action belongs to one of the two people in the 1:1.', 400);
		await limit(m, 'one_on_one_edit', ONE_ON_ONE_EDITS_PER_MINUTE, 60_000);
		await tx
			.insert(oneOnOneItems)
			.values({ tenantId: m.tenant.id, meetingId: mt.id, kind: input.kind, text: input.text, ownerEmployeeId: owner });
	});
}

async function itemOf(tx: Tx, m: Member, rawItem: string) {
	const iid = z.uuid({ error: 'Choose an item.' }).parse(rawItem);
	const [item] = await tx.select().from(oneOnOneItems).where(eq(oneOnOneItems.id, iid));
	if (!item) throw new AppError('not_found', 'That item does not exist.', 404);
	return { ...item, meeting: await participantOf(tx, m, item.meetingId) };
}

export async function toggleAction(m: Member, rawItem: string) {
	await withTenant(userCtx(m), async (tx) => {
		const item = await itemOf(tx, m, rawItem);
		if (item.kind !== 'action') throw new AppError('not_action', 'Only actions can be marked done.', 400);
		await limit(m, 'one_on_one_edit', ONE_ON_ONE_EDITS_PER_MINUTE, 60_000);
		await tx
			.update(oneOnOneItems)
			.set({ doneAt: item.doneAt ? null : new Date() })
			.where(eq(oneOnOneItems.id, item.id));
	});
}

export async function removeItem(m: Member, rawItem: string) {
	await withTenant(userCtx(m), async (tx) => {
		const item = await itemOf(tx, m, rawItem);
		if (item.meeting.status === 'cancelled') throw new AppError('cancelled', 'This 1:1 was cancelled.', 409);
		await tx.delete(oneOnOneItems).where(eq(oneOnOneItems.id, item.id));
	});
}

export async function savePrivateNote(m: Member, id: string, raw: string) {
	const text = noteSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const mt = await participantOf(tx, m, id);
		await limit(m, 'one_on_one_edit', ONE_ON_ONE_EDITS_PER_MINUTE, 60_000);
		const mine = and(
			eq(oneOnOnePrivateNotes.meetingId, mt.id),
			eq(oneOnOnePrivateNotes.authorMembershipId, m.access.membershipId)
		);
		if (!text) {
			await tx.delete(oneOnOnePrivateNotes).where(mine);
			return;
		}
		await tx
			.insert(oneOnOnePrivateNotes)
			.values({ tenantId: m.tenant.id, meetingId: mt.id, authorMembershipId: m.access.membershipId, text })
			.onConflictDoUpdate({
				target: [
					oneOnOnePrivateNotes.tenantId,
					oneOnOnePrivateNotes.meetingId,
					oneOnOnePrivateNotes.authorMembershipId
				],
				set: { text, updatedAt: sql`now()` }
			});
	});
}

export async function setMeetingStatus(m: Member, id: string, status: 'done' | 'cancelled') {
	await withTenant(userCtx(m), async (tx) => {
		const mt = await participantOf(tx, m, id);
		if (mt.status !== 'scheduled') throw new AppError('not_scheduled', 'This 1:1 is already closed.', 409);
		await tx.update(oneOnOnes).set({ status }).where(eq(oneOnOnes.id, mt.id));
	});
}

export async function forgetPrivateNotes(tx: Tx, membershipIds: string[]) {
	if (!membershipIds.length) return;
	await tx.delete(oneOnOnePrivateNotes).where(inArray(oneOnOnePrivateNotes.authorMembershipId, membershipIds));
}
