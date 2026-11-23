import { and, asc, desc, eq, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { activeMemberships, activeMembershipsOf, singleAdmin } from './approval-chain';
import type { ApprovalItem } from './approvals';
import { hoursOf } from '../project-labels';
import { now } from './clock';
import { addDays } from './dates';
import { employees, projectMembers, projects, timesheetEntries, timesheets } from './db/schema';
import { AppError } from './errors';
import { tenantWeeks } from './lifecycle';
import { notify } from './notifications';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Sheet = typeof timesheets.$inferSelect;

const hoursError = 'Log between 0.25 and 24 hours, in quarter hours.';
const entrySchema = z.object({
	projectId: z.uuid({ error: 'Choose a project.' }),
	workDate: z.iso.date('Choose a date.'),
	hours: z
		.string()
		.trim()
		.regex(/^\d{1,2}(\.\d{1,2})?$/, hoursError)
		.transform((h) => Math.round(Number(h) * 60))
		.refine((m) => m >= 15 && m <= 1440 && m % 15 === 0, hoursError),
	note: z.string().trim().max(300, 'Keep the note under 300 characters.').prefault('')
});
const entryId = z.uuid({ error: 'Choose an entry.' });
const weekSchema = z.object({ weekStart: z.iso.date('Choose a week.') });
const decisionSchema = z
	.object({
		decision: z.enum(['approved', 'rejected'], 'Approve or reject the timesheet.'),
		note: z.string().trim().max(300, 'Keep the note under 300 characters.').prefault('')
	})
	.refine((d) => d.decision === 'approved' || d.note, { message: 'Say why the timesheet goes back.' });

const editable = (s: Pick<Sheet, 'status'> | undefined) => !s || s.status === 'draft' || s.status === 'rejected';
const locked = () => new AppError('locked', 'This week is already submitted.', 409);
const notFound = () => new AppError('not_found', 'That timesheet does not exist.', 404);

function selfOf(m: Member) {
	if (!m.access.employeeId) throw new AppError('no_employee', 'Only employees keep timesheets.', 403);
	return m.access.employeeId;
}

const leadsOn = (sheetId: SQL | string, employeeId: string) =>
	sql`exists (select 1 from timesheet_entries te join project_members pm on pm.project_id = te.project_id where te.timesheet_id = ${sheetId} and pm.employee_id = ${employeeId} and pm.role = 'lead')`;

async function deciderOf(tx: Tx, access: Access, sheet: Sheet) {
	if (inScope(await resolveScope(tx, access, 'timesheet.approve'), sheet.employeeId)) return true;
	if (!access.employeeId) return false;
	const [e] = await tx
		.select({ managerId: employees.managerId })
		.from(employees)
		.where(eq(employees.id, sheet.employeeId));
	if (e?.managerId === access.employeeId) return true;
	const [lead] = await tx.execute<{ yes: boolean }>(sql`select ${leadsOn(sheet.id, access.employeeId)} as yes`);
	return !!lead?.yes;
}

async function myProjects(tx: Tx, employeeId: string) {
	return tx
		.select({ id: projects.id, code: projects.code, name: projects.name })
		.from(projectMembers)
		.innerJoin(projects, eq(projects.id, projectMembers.projectId))
		.where(and(eq(projectMembers.employeeId, employeeId), eq(projects.status, 'active')))
		.orderBy(asc(projects.code));
}

const entryFields = {
	id: timesheetEntries.id,
	projectId: timesheetEntries.projectId,
	code: projects.code,
	project: projects.name,
	workDate: timesheetEntries.workDate,
	minutes: timesheetEntries.minutes,
	note: timesheetEntries.note
};

const entriesOf = (tx: Tx, sheetId: string) =>
	tx
		.select(entryFields)
		.from(timesheetEntries)
		.innerJoin(projects, eq(projects.id, timesheetEntries.projectId))
		.where(eq(timesheetEntries.timesheetId, sheetId))
		.orderBy(asc(timesheetEntries.workDate), asc(projects.code));

export async function myWeek(tx: Tx, access: Access, requested: string | null) {
	if (!access.employeeId) return null;
	const w = await tenantWeeks(tx);
	const week = requested && weekSchema.shape.weekStart.safeParse(requested).success ? w.of(requested) : w.current;
	const [sheet] = await tx
		.select()
		.from(timesheets)
		.where(and(eq(timesheets.employeeId, access.employeeId), eq(timesheets.weekStart, week)));
	const recent = await tx
		.select({ id: timesheets.id, weekStart: timesheets.weekStart, status: timesheets.status })
		.from(timesheets)
		.where(eq(timesheets.employeeId, access.employeeId))
		.orderBy(desc(timesheets.weekStart))
		.limit(12);
	const days = Array.from({ length: 7 }, (_, i) => addDays(week, i)).filter((d) => d <= w.today);
	return {
		week,
		today: w.today,
		previous: addDays(week, -7),
		next: addDays(week, 7) <= w.today ? addDays(week, 7) : null,
		days,
		sheet: sheet ?? null,
		entries: sheet ? await entriesOf(tx, sheet.id) : [],
		projects: await myProjects(tx, access.employeeId),
		recent,
		canEdit: editable(sheet) && days.length > 0
	};
}

async function lockedSheet(tx: Tx, employeeId: string, week: string) {
	const [s] = await tx
		.select()
		.from(timesheets)
		.where(and(eq(timesheets.employeeId, employeeId), eq(timesheets.weekStart, week)))
		.for('update');
	return s;
}

export async function logTime(m: Member, raw: Record<string, string>) {
	const me = selfOf(m);
	const input = entrySchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const w = await tenantWeeks(tx);
		if (input.workDate > w.today) throw new AppError('future', 'Log time for today or earlier.', 400);
		const [member] = await tx
			.select({ id: projectMembers.id })
			.from(projectMembers)
			.innerJoin(projects, eq(projects.id, projectMembers.projectId))
			.where(
				and(
					eq(projectMembers.projectId, input.projectId),
					eq(projectMembers.employeeId, me),
					eq(projects.status, 'active')
				)
			);
		if (!member) throw new AppError('not_member', 'Log time only on active projects you are on.', 400);
		const week = w.of(input.workDate);
		await tx
			.insert(timesheets)
			.values({ tenantId: m.tenant.id, employeeId: me, weekStart: week })
			.onConflictDoNothing();
		const sheet = await lockedSheet(tx, me, week);
		if (!editable(sheet)) throw locked();
		const [{ other }] = await tx
			.select({ other: sql<number>`coalesce(sum(${timesheetEntries.minutes}), 0)::int` })
			.from(timesheetEntries)
			.where(
				and(
					eq(timesheetEntries.timesheetId, sheet.id),
					eq(timesheetEntries.workDate, input.workDate),
					ne(timesheetEntries.projectId, input.projectId)
				)
			);
		if (other + input.hours > 1440) throw new AppError('day_full', 'That day already has 24 hours logged.', 409);
		await tx
			.insert(timesheetEntries)
			.values({
				tenantId: m.tenant.id,
				timesheetId: sheet.id,
				projectId: input.projectId,
				workDate: input.workDate,
				minutes: input.hours,
				note: input.note
			})
			.onConflictDoUpdate({
				target: [
					timesheetEntries.tenantId,
					timesheetEntries.timesheetId,
					timesheetEntries.projectId,
					timesheetEntries.workDate
				],
				set: { minutes: input.hours, note: input.note }
			});
	});
}

export async function removeEntry(m: Member, raw: Record<string, string>) {
	const me = selfOf(m);
	const id = entryId.parse(raw.entryId);
	await withTenant(userCtx(m), async (tx) => {
		const [row] = await tx
			.select({ sheet: timesheets })
			.from(timesheetEntries)
			.innerJoin(timesheets, eq(timesheets.id, timesheetEntries.timesheetId))
			.where(and(eq(timesheetEntries.id, id), eq(timesheets.employeeId, me)))
			.for('update', { of: timesheets });
		if (!row) throw new AppError('not_found', 'That entry does not exist.', 404);
		if (!editable(row.sheet)) throw locked();
		await tx.delete(timesheetEntries).where(eq(timesheetEntries.id, id));
	});
}

export async function submitWeek(m: Member, raw: Record<string, string>) {
	const me = selfOf(m);
	const { weekStart } = weekSchema.parse(raw);
	return withTenant(userCtx(m), async (tx) => {
		const sheet = await lockedSheet(tx, me, weekStart);
		if (!sheet) throw new AppError('empty', 'Log some time before submitting.', 400);
		if (!editable(sheet)) throw locked();
		const leads = await tx
			.selectDistinct({ id: projectMembers.employeeId })
			.from(timesheetEntries)
			.innerJoin(
				projectMembers,
				and(eq(projectMembers.projectId, timesheetEntries.projectId), eq(projectMembers.role, 'lead'))
			)
			.where(eq(timesheetEntries.timesheetId, sheet.id));
		const [{ n }] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(timesheetEntries)
			.where(eq(timesheetEntries.timesheetId, sheet.id));
		if (!n) throw new AppError('empty', 'Log some time before submitting.', 400);
		await tx
			.update(timesheets)
			.set({ status: 'submitted', submittedAt: now(), decidedAt: null, decidedByUserId: null, decisionNote: null })
			.where(eq(timesheets.id, sheet.id));
		const [e] = await tx
			.select({ name: employees.fullName, managerId: employees.managerId })
			.from(employees)
			.where(eq(employees.id, me));
		const reviewers = [...leads.map((l) => l.id), ...(e.managerId ? [e.managerId] : [])].filter((id) => id !== me);
		return notify(
			tx,
			m.tenant.id,
			await activeMembershipsOf(tx, reviewers),
			{
				category: 'approvals',
				title: `${e.name} submitted the timesheet for the week of ${weekStart}`,
				link: `timesheets/${sheet.id}`
			},
			m.tenant.slug
		);
	});
}

export async function decideTimesheet(m: Member, timesheetId: string, raw: Record<string, string>) {
	const input = decisionSchema.parse(raw);
	if (!z.uuid().safeParse(timesheetId).success) throw notFound();
	return withTenant(userCtx(m), async (tx) => {
		const [sheet] = await tx.select().from(timesheets).where(eq(timesheets.id, timesheetId)).for('update');
		if (!sheet || !(sheet.employeeId === m.access.employeeId || (await deciderOf(tx, m.access, sheet))))
			throw notFound();
		if (sheet.status !== 'submitted') throw new AppError('not_pending', 'This timesheet is not waiting.', 409);
		if (sheet.employeeId === m.access.employeeId && !(await singleAdmin(tx)))
			throw new AppError('forbidden', 'Someone else must approve your timesheet.', 403);
		await tx
			.update(timesheets)
			.set({
				status: input.decision,
				decidedAt: now(),
				decidedByUserId: m.user.userId,
				decisionNote: input.note || null
			})
			.where(eq(timesheets.id, sheet.id));
		const verb = input.decision === 'approved' ? 'approved' : 'sent back';
		return notify(
			tx,
			m.tenant.id,
			await activeMemberships(tx, sheet.employeeId),
			{
				category: 'approvals',
				title: `Your timesheet for the week of ${sheet.weekStart} was ${verb}`,
				body: input.note || undefined,
				link: 'timesheets'
			},
			m.tenant.slug
		);
	});
}

export async function timesheetView(tx: Tx, access: Access, id: string) {
	if (!z.uuid().safeParse(id).success) return null;
	const [row] = await tx
		.select({ sheet: timesheets, name: employees.fullName })
		.from(timesheets)
		.innerJoin(employees, eq(employees.id, timesheets.employeeId))
		.where(eq(timesheets.id, id));
	if (!row) return null;
	const own = row.sheet.employeeId === access.employeeId;
	const decider = !own && (await deciderOf(tx, access, row.sheet));
	if (!own && !decider) return null;
	const pending = row.sheet.status === 'submitted';
	return {
		...row,
		entries: await entriesOf(tx, id),
		canDecide: pending && (decider || (own && (await singleAdmin(tx))))
	};
}

export async function timesheetApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	const scope = await resolveScope(tx, access, 'timesheet.approve');
	const me = access.employeeId;
	const rows = await tx
		.select({
			id: timesheets.id,
			name: employees.fullName,
			weekStart: timesheets.weekStart,
			at: timesheets.submittedAt,
			minutes: sql<number>`(select coalesce(sum(te.minutes), 0)::int from timesheet_entries te where te.timesheet_id = timesheets.id)`
		})
		.from(timesheets)
		.innerJoin(employees, eq(employees.id, timesheets.employeeId))
		.where(
			and(
				eq(timesheets.status, 'submitted'),
				me
					? and(
							ne(timesheets.employeeId, me),
							or(
								scopeWhere(scope, timesheets.employeeId),
								eq(employees.managerId, me),
								leadsOn(sql`${timesheets.id}`, me)
							)
						)
					: scopeWhere(scope, timesheets.employeeId)
			)
		)
		.orderBy(asc(timesheets.submittedAt))
		.limit(200);
	return rows.map((r) => ({
		id: r.id,
		kind: 'Timesheet',
		title: `${r.name}: week of ${r.weekStart} · ${hoursOf(r.minutes)} h`,
		requestedBy: r.name,
		at: r.at ?? new Date(0),
		link: `timesheets/${r.id}`
	}));
}
