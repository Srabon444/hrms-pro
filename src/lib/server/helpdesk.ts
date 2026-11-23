import { aliasedTable, and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Permission } from '../rbac/permissions';
import { now } from './clock';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import {
	employees,
	membershipRoles,
	memberships,
	rolePermissions,
	ticketCategories,
	ticketComments,
	TICKET_PRIORITIES,
	TICKET_STATUSES,
	tickets
} from './db/schema';
import { AppError } from './errors';
import { advisoryLock, LOCK } from './locks';
import { notify } from './notifications';
import { activeMemberships } from './approval-chain';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const DEFAULT_TICKET_CATEGORIES = [
	{ name: 'IT support', slaHours: 24, confidential: false },
	{ name: 'HR query', slaHours: 48, confidential: false },
	{ name: 'Payroll', slaHours: 48, confidential: false },
	{ name: 'Facilities', slaHours: 72, confidential: false },
	{ name: 'Grievance', slaHours: 24, confidential: true }
];

export const seedTicketCategories = (tx: Tx, tenantId: string) =>
	tx
		.insert(ticketCategories)
		.values(DEFAULT_TICKET_CATEGORIES.map((c) => ({ tenantId, ...c })))
		.onConflictDoNothing();

const checkbox = z.preprocess((v) => v === 'on' || v === true, z.boolean());
const uuid = (msg: string) => z.uuid({ error: msg });
const text = (max: number, empty: string, long: string) => z.string().trim().min(1, empty).max(max, long);

const categorySchema = z.object({
	categoryId: z
		.union([z.literal(''), uuid('Choose a category.')])
		.transform((v) => v || null)
		.prefault(''),
	name: text(60, 'Name the category.', 'Keep the name under 60 characters.'),
	slaHours: z.coerce
		.number('Enter the response time in hours.')
		.int('Use whole hours.')
		.min(1, 'Allow at least 1 hour.')
		.max(720, 'Keep the response time within 720 hours.'),
	confidential: checkbox,
	active: checkbox
});
const ticketSchema = z.object({
	categoryId: uuid('Choose a category.'),
	subject: text(160, 'Add a subject.', 'Keep the subject under 160 characters.'),
	description: text(5000, 'Describe the problem.', 'Keep the description under 5000 characters.'),
	priority: z.enum(TICKET_PRIORITIES, 'Choose a priority.').prefault('normal')
});
const updateSchema = z.object({
	ticketId: uuid('Choose a ticket.'),
	status: z.enum(TICKET_STATUSES, 'Choose a status.'),
	priority: z.enum(TICKET_PRIORITIES, 'Choose a priority.'),
	assignee: z
		.union([z.literal(''), uuid('Choose who handles it.')])
		.transform((v) => v || null)
		.prefault('')
});
const commentSchema = z.object({
	ticketId: uuid('Choose a ticket.'),
	body: text(5000, 'Write a comment.', 'Keep the comment under 5000 characters.'),
	internal: checkbox
});
const requesterSchema = z.object({
	ticketId: uuid('Choose a ticket.'),
	action: z.enum(['reopen', 'close'], 'Choose reopen or close.')
});

const notFound = () => new AppError('not_found', 'That ticket does not exist.', 404);
const closed = () => new AppError('closed', 'This ticket is closed.', 409);
const agentPerm = (confidential: boolean): Permission => (confidential ? 'helpdesk.confidential' : 'helpdesk.manage');
const runsAll = (access: Access, p: Permission) => scopesOf(access, p).includes('all');
export const canRunHelpdesk = (access: Access) => runsAll(access, 'helpdesk.manage');

async function visibleTickets(tx: Tx, access: Access): Promise<SQL> {
	const [manage, secret] = await Promise.all([
		resolveScope(tx, access, 'helpdesk.manage'),
		resolveScope(tx, access, 'helpdesk.confidential')
	]);
	const within = (s: typeof manage) =>
		s.kind === 'all' ? sql`true` : s.ids.length ? inArray(tickets.requesterEmployeeId, s.ids) : sql`false`;
	return or(
		access.employeeId ? eq(tickets.requesterEmployeeId, access.employeeId) : sql`false`,
		and(eq(ticketCategories.confidential, false), within(manage)),
		and(eq(ticketCategories.confidential, true), within(secret))
	)!;
}

const nameOf = (
	membershipColumn: 'memberships.id' | 'tickets.assignee_membership_id' | 'ticket_comments.author_membership_id'
) => sql<string | null>`(select tu.name from tenant_users tu where tu.membership_id = ${sql.raw(membershipColumn)})`;

async function agentsFor(tx: Tx, confidential: boolean) {
	return tx
		.selectDistinct({ id: memberships.id, name: nameOf('memberships.id') })
		.from(membershipRoles)
		.innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
		.innerJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
		.where(
			and(
				eq(rolePermissions.permission, agentPerm(confidential)),
				eq(rolePermissions.scope, 'all'),
				eq(memberships.status, 'active')
			)
		)
		.orderBy(asc(nameOf('memberships.id')));
}

export async function saveCategory(m: Member, raw: Record<string, string>) {
	const { categoryId, ...input } = categorySchema.parse(raw);
	if (!canRunHelpdesk(m.access)) throw new AppError('forbidden', 'Only helpdesk managers can change categories.', 403);
	return withTenant(userCtx(m), async (tx) => {
		const [current] = categoryId
			? await tx.select().from(ticketCategories).where(eq(ticketCategories.id, categoryId)).for('update')
			: [];
		if (categoryId && !current) throw new AppError('not_found', 'That category does not exist.', 404);
		if ((input.confidential || current?.confidential) && !runsAll(m.access, 'helpdesk.confidential'))
			throw new AppError('forbidden', 'Only people who handle confidential tickets can change that category.', 403);
		const clash = (err: unknown) => {
			if (pgCode(err) === UNIQUE_VIOLATION)
				throw new AppError('name_exists', 'Another category already uses that name.', 409);
			throw err;
		};
		if (current) {
			await tx.update(ticketCategories).set(input).where(eq(ticketCategories.id, current.id)).catch(clash);
			return current.id;
		}
		const [c] = await tx
			.insert(ticketCategories)
			.values({ tenantId: m.tenant.id, ...input })
			.returning({ id: ticketCategories.id })
			.catch(clash);
		return c.id;
	});
}

export async function createTicket(m: Member, raw: Record<string, string>) {
	const input = ticketSchema.parse(raw);
	const me = m.access.employeeId;
	if (!me) throw new AppError('no_employee', 'Your account is not linked to an employee record.', 400);
	return withTenant(userCtx(m), async (tx) => {
		const [category] = await tx
			.select()
			.from(ticketCategories)
			.where(and(eq(ticketCategories.id, input.categoryId), eq(ticketCategories.active, true)));
		if (!category) throw new AppError('invalid_category', 'Choose an open category.', 400);
		await advisoryLock(tx, LOCK.helpdesk, m.tenant.id);
		const [{ next }] = await tx
			.select({ next: sql<number>`coalesce(max(${tickets.number}), 0)::int + 1` })
			.from(tickets);
		const opened = now();
		const [t] = await tx
			.insert(tickets)
			.values({
				tenantId: m.tenant.id,
				number: next,
				categoryId: category.id,
				requesterEmployeeId: me,
				subject: input.subject,
				description: input.description,
				priority: input.priority,
				slaDueAt: new Date(opened.getTime() + category.slaHours * 3_600_000)
			})
			.returning({ id: tickets.id });
		const agents = (await agentsFor(tx, category.confidential))
			.map((a) => a.id)
			.filter((id) => id !== m.access.membershipId);
		const mails = await notify(
			tx,
			m.tenant.id,
			agents,
			{
				category: 'helpdesk',
				title: `New ${category.name} ticket #${next}: ${input.subject}`,
				link: `helpdesk/${t.id}`
			},
			m.tenant.slug
		);
		return { id: t.id, mails };
	});
}

async function lockedTicket(tx: Tx, access: Access, id: string) {
	const [row] = await tx
		.select({ ticket: tickets, confidential: ticketCategories.confidential })
		.from(tickets)
		.innerJoin(ticketCategories, eq(ticketCategories.id, tickets.categoryId))
		.where(and(eq(tickets.id, id), await visibleTickets(tx, access)))
		.for('update', { of: tickets });
	if (!row) throw notFound();
	const scope = await resolveScope(tx, access, agentPerm(row.confidential));
	return {
		...row.ticket,
		confidential: row.confidential,
		agent: inScope(scope, row.ticket.requesterEmployeeId),
		requester: row.ticket.requesterEmployeeId === access.employeeId
	};
}

const settled = (status: string) => status === 'resolved' || status === 'closed';
const label = (t: { number: number; subject: string }) => `#${t.number} ${t.subject}`;

export async function updateTicket(m: Member, raw: Record<string, string>) {
	const input = updateSchema.parse(raw);
	return withTenant(userCtx(m), async (tx) => {
		const t = await lockedTicket(tx, m.access, input.ticketId);
		if (!t.agent) throw new AppError('forbidden', 'Only the helpdesk can change this ticket.', 403);
		if (t.status === 'closed') throw closed();
		if (input.assignee && input.assignee !== t.assigneeMembershipId) {
			const agents = await agentsFor(tx, t.confidential);
			if (!agents.some((a) => a.id === input.assignee))
				throw new AppError('invalid_assignee', 'Choose someone who handles these tickets.', 400);
		}
		await tx
			.update(tickets)
			.set({
				status: input.status,
				priority: input.priority,
				assigneeMembershipId: input.assignee,
				resolvedAt: settled(input.status) ? (settled(t.status) ? t.resolvedAt : now()) : null
			})
			.where(eq(tickets.id, t.id));
		const self = m.access.membershipId;
		const link = `helpdesk/${t.id}`;
		const mails = [];
		if (input.status !== t.status && !t.requester)
			mails.push(
				...(await notify(
					tx,
					m.tenant.id,
					await activeMemberships(tx, t.requesterEmployeeId),
					{ category: 'helpdesk', title: `Ticket ${label(t)} is now ${input.status.replace('_', ' ')}`, link },
					m.tenant.slug
				))
			);
		if (input.assignee && input.assignee !== t.assigneeMembershipId && input.assignee !== self)
			mails.push(
				...(await notify(
					tx,
					m.tenant.id,
					[input.assignee],
					{ category: 'helpdesk', title: `Ticket ${label(t)} was assigned to you`, link },
					m.tenant.slug
				))
			);
		return mails;
	});
}

export async function commentOnTicket(m: Member, raw: Record<string, string>) {
	const input = commentSchema.parse(raw);
	return withTenant(userCtx(m), async (tx) => {
		const t = await lockedTicket(tx, m.access, input.ticketId);
		if (t.status === 'closed') throw closed();
		if (input.internal && !t.agent) throw new AppError('forbidden', 'Only the helpdesk can add internal notes.', 403);
		await tx.insert(ticketComments).values({
			tenantId: m.tenant.id,
			ticketId: t.id,
			authorMembershipId: m.access.membershipId,
			body: input.body,
			internal: input.internal
		});
		const fromRequester = t.requester && !input.internal;
		if (fromRequester && t.status === 'waiting')
			await tx.update(tickets).set({ status: 'open' }).where(eq(tickets.id, t.id));
		const self = m.access.membershipId;
		const recipients = input.internal
			? [t.assigneeMembershipId]
			: fromRequester
				? t.assigneeMembershipId
					? [t.assigneeMembershipId]
					: (await agentsFor(tx, t.confidential)).map((a) => a.id)
				: await activeMemberships(tx, t.requesterEmployeeId);
		return notify(
			tx,
			m.tenant.id,
			recipients.filter((id): id is string => !!id && id !== self),
			{ category: 'helpdesk', title: `New comment on ticket ${label(t)}`, link: `helpdesk/${t.id}` },
			m.tenant.slug
		);
	});
}

export async function requesterAction(m: Member, raw: Record<string, string>) {
	const input = requesterSchema.parse(raw);
	return withTenant(userCtx(m), async (tx) => {
		const t = await lockedTicket(tx, m.access, input.ticketId);
		if (!t.requester) throw new AppError('forbidden', 'Only the person who raised it can do that.', 403);
		if (t.status !== 'resolved')
			throw new AppError('not_resolved', 'Only resolved tickets can be reopened or closed.', 409);
		const reopen = input.action === 'reopen';
		await tx
			.update(tickets)
			.set(reopen ? { status: 'open', resolvedAt: null } : { status: 'closed' })
			.where(eq(tickets.id, t.id));
		if (!reopen || !t.assigneeMembershipId || t.assigneeMembershipId === m.access.membershipId) return [];
		return notify(
			tx,
			m.tenant.id,
			[t.assigneeMembershipId],
			{ category: 'helpdesk', title: `Ticket ${label(t)} was reopened`, link: `helpdesk/${t.id}` },
			m.tenant.slug
		);
	});
}

const requester = aliasedTable(employees, 'requester');
const overdue = () =>
	sql<boolean>`((${tickets.status} not in ('resolved','closed') and ${tickets.slaDueAt} < ${now().toISOString()}::timestamptz) or coalesce(${tickets.resolvedAt} > ${tickets.slaDueAt}, false))`;

const LIST_FILTERS = ['active', 'mine', 'overdue', 'settled', 'all'] as const;
export type TicketFilter = (typeof LIST_FILTERS)[number];

export async function ticketList(tx: Tx, access: Access, rawFilter: string | null) {
	const filter = z.enum(LIST_FILTERS).catch('active').parse(rawFilter);
	const active = inArray(tickets.status, ['open', 'in_progress', 'waiting']);
	const where: Record<TicketFilter, SQL | undefined> = {
		active,
		mine: or(
			eq(tickets.assigneeMembershipId, access.membershipId),
			access.employeeId ? eq(tickets.requesterEmployeeId, access.employeeId) : sql`false`
		),
		overdue: and(active, overdue()),
		settled: inArray(tickets.status, ['resolved', 'closed']),
		all: undefined
	};
	const rows = await tx
		.select({
			id: tickets.id,
			number: tickets.number,
			subject: tickets.subject,
			category: ticketCategories.name,
			confidential: ticketCategories.confidential,
			priority: tickets.priority,
			status: tickets.status,
			requester: requester.fullName,
			assignee: nameOf('tickets.assignee_membership_id'),
			slaDueAt: tickets.slaDueAt,
			overdue: overdue()
		})
		.from(tickets)
		.innerJoin(ticketCategories, eq(ticketCategories.id, tickets.categoryId))
		.innerJoin(requester, eq(requester.id, tickets.requesterEmployeeId))
		.where(and(await visibleTickets(tx, access), where[filter]))
		.orderBy(desc(tickets.number))
		.limit(500);
	return { filter, rows };
}

export async function categoryOptions(tx: Tx, all = false) {
	return tx
		.select()
		.from(ticketCategories)
		.where(all ? undefined : eq(ticketCategories.active, true))
		.orderBy(asc(ticketCategories.name));
}

export async function ticketView(tx: Tx, access: Access, id: string) {
	if (!z.uuid().safeParse(id).success) return null;
	const [row] = await tx
		.select({
			ticket: tickets,
			category: ticketCategories.name,
			confidential: ticketCategories.confidential,
			requester: requester.fullName,
			assignee: nameOf('tickets.assignee_membership_id'),
			overdue: overdue()
		})
		.from(tickets)
		.innerJoin(ticketCategories, eq(ticketCategories.id, tickets.categoryId))
		.innerJoin(requester, eq(requester.id, tickets.requesterEmployeeId))
		.where(and(eq(tickets.id, id), await visibleTickets(tx, access)));
	if (!row) return null;
	const agent = inScope(await resolveScope(tx, access, agentPerm(row.confidential)), row.ticket.requesterEmployeeId);
	const comments = await tx
		.select({
			id: ticketComments.id,
			body: ticketComments.body,
			internal: ticketComments.internal,
			at: ticketComments.createdAt,
			author: nameOf('ticket_comments.author_membership_id')
		})
		.from(ticketComments)
		.where(and(eq(ticketComments.ticketId, id), agent ? undefined : eq(ticketComments.internal, false)))
		.orderBy(asc(ticketComments.createdAt), asc(ticketComments.id));
	return {
		...row,
		comments,
		agent,
		isRequester: row.ticket.requesterEmployeeId === access.employeeId,
		agents: agent ? await agentsFor(tx, row.confidential) : []
	};
}
