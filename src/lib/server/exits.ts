import { and, asc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { dropOffboarding, moveOffboarding, startChecklists } from './checklists';
import { now } from './clock';
import { authPool } from './db';
import {
	departments,
	employeeHistory,
	employees,
	EXIT_TYPES,
	membershipRoles,
	memberships,
	roles,
	tenants,
	tenantSettings
} from './db/schema';
import { text } from './employees';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { log } from './log';
import { notify, sendAll } from './notifications';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { lockOwnerRole, otherActiveOwners } from './rbac/members';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { systemCtx, withTenant, type Tx } from './tenancy';
import type { Mail } from './mail';

type Member = ReturnType<typeof requireMember>;
type Employee = typeof employees.$inferSelect;

const notFound = () => new AppError('not_found', 'That employee does not exist.', 404);
const label = (e: { fullName: string; code: string }) => `${e.fullName} (${e.code})`;

export async function lockEmployee(tx: Tx, access: Access, employeeId: string): Promise<Employee> {
	const id = z.uuid().safeParse(employeeId);
	const [e] = id.success ? await tx.select().from(employees).where(eq(employees.id, id.data)).for('update') : [];
	if (!e || !inScope(await resolveScope(tx, access, 'employee.read'), e.id)) throw notFound();
	return e;
}

export async function hrMemberships(tx: Tx): Promise<string[]> {
	const rows = await tx
		.selectDistinct({ id: memberships.id })
		.from(membershipRoles)
		.innerJoin(roles, eq(roles.id, membershipRoles.roleId))
		.innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
		.where(and(inArray(roles.key, ['owner', 'hr_admin']), eq(memberships.status, 'active')));
	return rows.map((r) => r.id);
}

async function completeExit(
	tx: Tx,
	tenant: { id: string; slug: string },
	e: Employee,
	actorUserId: string | null
): Promise<Mail[]> {
	const [membership] = await tx
		.select({ id: memberships.id, status: memberships.status })
		.from(memberships)
		.where(eq(memberships.employeeId, e.id));
	if (membership) {
		const ownerRoleId = await lockOwnerRole(tx);
		const [isOwner] = await tx
			.select({ id: membershipRoles.id })
			.from(membershipRoles)
			.where(and(eq(membershipRoles.membershipId, membership.id), eq(membershipRoles.roleId, ownerRoleId)));
		if (isOwner && membership.status === 'active' && (await otherActiveOwners(tx, ownerRoleId, membership.id)) === 0)
			throw new AppError('last_owner', 'Hand ownership to someone else before this person leaves.', 409);
	}

	const [boss] = e.managerId
		? await tx
				.select({ fullName: employees.fullName, code: employees.code })
				.from(employees)
				.where(eq(employees.id, e.managerId))
		: [];
	const reports = await tx
		.update(employees)
		.set({ managerId: e.managerId })
		.where(eq(employees.managerId, e.id))
		.returning({ id: employees.id, fullName: employees.fullName });
	if (reports.length)
		await tx.insert(employeeHistory).values(
			reports.map((r) => ({
				tenantId: tenant.id,
				employeeId: r.id,
				field: 'managerId',
				oldValue: label(e),
				newValue: boss ? label(boss) : null,
				changedByUserId: actorUserId
			}))
		);
	const headless = await tx
		.update(departments)
		.set({ headEmployeeId: null })
		.where(eq(departments.headEmployeeId, e.id))
		.returning({ name: departments.name });

	await tx.update(employees).set({ status: 'exited' }).where(eq(employees.id, e.id));
	await tx.insert(employeeHistory).values({
		tenantId: tenant.id,
		employeeId: e.id,
		field: 'status',
		oldValue: e.status,
		newValue: 'exited',
		changedByUserId: actorUserId
	});

	if (membership && membership.status === 'active') {
		const [s] = await tx
			.select({ days: tenantSettings.exEmployeeAccessDays, tz: tenantSettings.timezone })
			.from(tenantSettings);
		await tx
			.update(memberships)
			.set({
				status: 'ex_employee',
				exAccessUntil: sql`((${e.exitDate}::date + ${(s?.days ?? 90) + 1}::int)::timestamp at time zone ${s?.tz ?? 'UTC'})`
			})
			.where(eq(memberships.id, membership.id));
		await tx.delete(membershipRoles).where(eq(membershipRoles.membershipId, membership.id));
	}

	const notes = [
		reports.length
			? `${reports.length} direct report${reports.length === 1 ? '' : 's'} now report to ${boss ? label(boss) : 'nobody'}: ${reports.map((r) => r.fullName).join(', ')}.`
			: '',
		headless.length ? `Departments that need a new head: ${headless.map((d) => d.name).join(', ')}.` : ''
	].filter(Boolean);
	return notify(
		tx,
		tenant.id,
		await hrMemberships(tx),
		{
			category: 'people',
			title: `${label(e)} has left`,
			body: notes.join('\n') || undefined,
			link: `employees/${e.id}`
		},
		tenant.slug
	);
}

const exitSchema = z.object({
	exitDate: z.iso.date('Enter the last working day.'),
	exitType: z.enum(EXIT_TYPES, { error: 'Choose how they are leaving.' }),
	exitReason: text(500)
});

async function assertCanExit(tx: Tx, m: Member, e: Employee) {
	if (!inScope(await resolveScope(tx, m.access, 'employee.delete'), e.id))
		throw new AppError('forbidden', 'You cannot record exits for this person.', 403);
	if (m.access.employeeId === e.id) throw new AppError('self_change', 'Someone else has to record your own exit.', 403);
}

export async function applyExit(tx: Tx, m: Member, e: Employee, input: z.infer<typeof exitSchema>): Promise<Mail[]> {
	if (e.status === 'exited') throw new AppError('exited', 'This person has already left.', 409);
	if (input.exitDate < e.joinDate)
		throw new AppError('before_join', 'The last day cannot be before the join date.', 400);
	if (e.status === 'notice' && e.exitDate && e.exitDate !== input.exitDate)
		await moveOffboarding(tx, e.id, e.exitDate, input.exitDate);
	await startChecklists(tx, m.tenant.id, e.id, 'offboarding', input.exitDate);
	const today = await tenantToday(tx);
	const due = input.exitDate <= today;
	await tx
		.update(employees)
		.set({ ...input, status: due ? e.status : 'notice' })
		.where(eq(employees.id, e.id));
	if (!due) {
		if (e.status !== 'notice')
			await tx.insert(employeeHistory).values({
				tenantId: m.tenant.id,
				employeeId: e.id,
				field: 'status',
				oldValue: e.status,
				newValue: 'notice',
				changedByUserId: m.user.userId
			});
		return [];
	}
	return completeExit(tx, m.tenant, { ...e, ...input }, m.user.userId);
}

export async function recordExit(m: Member, employeeId: string, raw: Record<string, string>) {
	const input = exitSchema.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		const e = await lockEmployee(tx, m.access, employeeId);
		await assertCanExit(tx, m, e);
		return applyExit(tx, m, e, input);
	});
	await sendAll(mails);
}

export async function withdrawExit(m: Member, employeeId: string) {
	await withTenant(userCtx(m), async (tx) => {
		const e = await lockEmployee(tx, m.access, employeeId);
		await assertCanExit(tx, m, e);
		if (e.status !== 'notice' || !e.exitDate)
			throw new AppError('no_pending_exit', 'This person has no upcoming exit.', 409);
		await dropOffboarding(tx, e.id, e.exitDate);
		await tx
			.update(employees)
			.set({ status: 'active', exitDate: null, exitType: null, exitReason: null })
			.where(eq(employees.id, e.id));
		await tx.insert(employeeHistory).values({
			tenantId: m.tenant.id,
			employeeId: e.id,
			field: 'status',
			oldValue: 'notice',
			newValue: 'active',
			changedByUserId: m.user.userId
		});
	});
}

const rehireSchema = z.object({ joinDate: z.iso.date('Enter the new join date.') });

export async function rehire(m: Member, employeeId: string, raw: Record<string, string>) {
	const { joinDate } = rehireSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const e = await lockEmployee(tx, m.access, employeeId);
		if (!inScope(await resolveScope(tx, m.access, 'employee.create'), e.id))
			throw new AppError('forbidden', 'You cannot rehire this person.', 403);
		if (e.status !== 'exited') throw new AppError('not_exited', 'Only people who have left can be rehired.', 409);
		if (e.exitDate && joinDate <= e.exitDate)
			throw new AppError('before_exit', 'The new join date must be after their last day.', 400);
		await tx
			.update(employees)
			.set({
				status: 'onboarding',
				joinDate,
				exitDate: null,
				exitType: null,
				exitReason: null,
				probationEndDate: null,
				confirmationDate: null
			})
			.where(eq(employees.id, e.id));
		await startChecklists(tx, m.tenant.id, e.id, 'onboarding', joinDate);
		await tx.insert(employeeHistory).values({
			tenantId: m.tenant.id,
			employeeId: e.id,
			field: 'status',
			oldValue: 'exited',
			newValue: 'onboarding',
			changedByUserId: m.user.userId
		});
		const [membership] = await tx
			.update(memberships)
			.set({ status: 'active', exAccessUntil: null })
			.where(and(eq(memberships.employeeId, e.id), ne(memberships.status, 'active')))
			.returning({ id: memberships.id });
		if (membership) {
			const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, 'employee'));
			if (role)
				await tx
					.insert(membershipRoles)
					.values({ tenantId: m.tenant.id, membershipId: membership.id, roleId: role.id })
					.onConflictDoNothing();
		}
	});
}

export async function upcomingExits(tx: Tx, access: Access) {
	const scope = await resolveScope(tx, access, 'employee.delete');
	return tx
		.select({
			id: employees.id,
			code: employees.code,
			fullName: employees.fullName,
			exitDate: employees.exitDate,
			exitType: employees.exitType
		})
		.from(employees)
		.where(and(eq(employees.status, 'notice'), scopeWhere(scope, employees.id)))
		.orderBy(asc(employees.exitDate), asc(employees.code))
		.limit(200);
}

export async function exitRights(tx: Tx, access: Access, e: { id: string; status: string }) {
	const own = access.employeeId === e.id;
	return {
		canExit: !own && e.status !== 'exited' && inScope(await resolveScope(tx, access, 'employee.delete'), e.id),
		canRehire: e.status === 'exited' && inScope(await resolveScope(tx, access, 'employee.create'), e.id)
	};
}

export async function runTenantLifecycle(tenant: { id: string; slug: string }) {
	const mails = await withTenant(systemCtx(tenant.id), async (tx) => {
		const today = await tenantToday(tx);
		const due = await tx
			.select()
			.from(employees)
			.where(and(ne(employees.status, 'exited'), lte(employees.exitDate, today)))
			.orderBy(asc(employees.exitDate))
			.for('update', { skipLocked: true });
		const out: Mail[] = [];
		for (const e of due) {
			const done = await tx
				.transaction((sp) => completeExit(sp, tenant, e, null))
				.catch((err) => {
					log.warn({ tenantId: tenant.id, employeeId: e.id, err: (err as Error).message }, 'exit not completed');
					return [];
				});
			out.push(...done);
		}
		await tx
			.update(memberships)
			.set({ status: 'disabled' })
			.where(and(eq(memberships.status, 'ex_employee'), lte(memberships.exAccessUntil, now())));
		return out;
	});
	await sendAll(mails);
}

export async function runLifecycle() {
	const list = await authPool()
		.db.select({ id: tenants.id, slug: tenants.slug })
		.from(tenants)
		.where(eq(tenants.status, 'active'));
	for (const t of list)
		await runTenantLifecycle(t).catch((err) =>
			log.error({ tenantId: t.id, err: (err as Error).message }, 'lifecycle run failed')
		);
}
