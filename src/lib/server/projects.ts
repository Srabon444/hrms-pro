import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AttachmentRules } from './attachments';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { employees, PROJECT_ROLES, PROJECT_STATUSES, projectMembers, projects } from './db/schema';
import { AppError } from './errors';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { resolveScope, type ScopeSet } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

const projectSchema = z.object({
	projectId: z
		.union([z.literal(''), z.uuid({ error: 'Choose a project.' })])
		.transform((v) => v || null)
		.prefault(''),
	code: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z0-9][A-Z0-9-]{1,11}$/, 'Use 2 to 12 letters, digits or dashes for the code.'),
	name: z.string().trim().min(1, 'Name the project.').max(120, 'Keep the name under 120 characters.'),
	client: z.string().trim().max(120, 'Keep the client under 120 characters.').prefault(''),
	status: z.enum(PROJECT_STATUSES, 'Choose a status.').prefault('active'),
	billable: z
		.string()
		.optional()
		.transform((v) => v === 'on')
});

const allocationError = 'Allocation is 1 to 100 percent.';
const memberSchema = z.object({
	projectId: z.uuid({ error: 'Choose a project.' }),
	employeeId: z.uuid({ error: 'Choose an employee.' }),
	role: z.enum(PROJECT_ROLES, 'Choose member or lead.').prefault('member'),
	allocation: z.coerce.number(allocationError).int(allocationError).min(1, allocationError).max(100, allocationError)
});

const notFound = () => new AppError('not_found', 'That project does not exist.', 404);
export const canRunProjects = (access: Access) => scopesOf(access, 'project.manage').includes('all');
const onlyManagers = (access: Access) => {
	if (!canRunProjects(access)) throw new AppError('forbidden', 'Only project managers can change projects.', 403);
};

const visible = (scope: ScopeSet) =>
	scope.kind === 'all'
		? sql`true`
		: scope.ids.length
			? sql`exists (select 1 from project_members pm where pm.project_id = ${projects.id} and pm.employee_id in ${scope.ids})`
			: sql`false`;

export async function saveProject(m: Member, raw: Record<string, string>) {
	const { projectId, ...input } = projectSchema.parse(raw);
	onlyManagers(m.access);
	return withTenant(userCtx(m), async (tx) => {
		const clash = (err: unknown) => {
			if (pgCode(err) === UNIQUE_VIOLATION)
				throw new AppError('code_exists', 'Another project already uses that code.', 409);
			throw err;
		};
		if (!projectId) {
			const [p] = await tx
				.insert(projects)
				.values({ tenantId: m.tenant.id, ...input, createdByUserId: m.user.userId })
				.returning({ id: projects.id })
				.catch(clash);
			return p.id;
		}
		const updated = await tx
			.update(projects)
			.set(input)
			.where(eq(projects.id, projectId))
			.returning({ id: projects.id })
			.catch(clash);
		if (!updated.length) throw notFound();
		return projectId;
	});
}

export async function setProjectMember(m: Member, raw: Record<string, string>) {
	const input = memberSchema.parse(raw);
	onlyManagers(m.access);
	await withTenant(userCtx(m), async (tx) => {
		const [p] = await tx.select({ status: projects.status }).from(projects).where(eq(projects.id, input.projectId));
		if (!p) throw notFound();
		if (p.status === 'closed') throw new AppError('closed', 'Reopen the project before changing its team.', 409);
		const [e] = await tx
			.select({ name: employees.fullName, status: employees.status })
			.from(employees)
			.where(eq(employees.id, input.employeeId))
			.for('update');
		if (!e || e.status === 'exited') throw new AppError('invalid_employee', 'Choose a current employee.', 400);
		const [{ elsewhere }] = await tx
			.select({ elsewhere: sql<number>`coalesce(sum(${projectMembers.allocation}), 0)::int` })
			.from(projectMembers)
			.innerJoin(projects, eq(projects.id, projectMembers.projectId))
			.where(
				and(
					eq(projectMembers.employeeId, input.employeeId),
					ne(projectMembers.projectId, input.projectId),
					ne(projects.status, 'closed')
				)
			);
		if (elsewhere + input.allocation > 100)
			throw new AppError(
				'over_allocated',
				`${e.name} is already ${elsewhere}% allocated on other projects; at most ${100 - elsewhere}% is left.`,
				409
			);
		await tx
			.insert(projectMembers)
			.values({ tenantId: m.tenant.id, ...input })
			.onConflictDoUpdate({
				target: [projectMembers.tenantId, projectMembers.projectId, projectMembers.employeeId],
				set: { role: input.role, allocation: input.allocation }
			});
	});
}

export async function removeProjectMember(m: Member, raw: Record<string, string>) {
	const input = memberSchema.pick({ projectId: true, employeeId: true }).parse(raw);
	onlyManagers(m.access);
	await withTenant(userCtx(m), async (tx) => {
		const gone = await tx
			.delete(projectMembers)
			.where(and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.employeeId, input.employeeId)))
			.returning({ id: projectMembers.id });
		if (!gone.length) throw new AppError('not_found', 'That person is not on the project.', 404);
	});
}

export async function projectList(tx: Tx, access: Access) {
	const scope = await resolveScope(tx, access, 'project.read');
	return tx
		.select({
			id: projects.id,
			code: projects.code,
			name: projects.name,
			client: projects.client,
			status: projects.status,
			billable: projects.billable,
			members: sql<number>`(select count(*)::int from project_members pm where pm.project_id = projects.id)`
		})
		.from(projects)
		.where(visible(scope))
		.orderBy(asc(projects.status), asc(projects.code));
}

export async function projectView(tx: Tx, access: Access, id: string) {
	if (!z.uuid().safeParse(id).success) return null;
	const scope = await resolveScope(tx, access, 'project.read');
	const [project] = await tx
		.select()
		.from(projects)
		.where(and(eq(projects.id, id), visible(scope)));
	if (!project) return null;
	const members = await tx
		.select({
			employeeId: projectMembers.employeeId,
			name: employees.fullName,
			role: projectMembers.role,
			allocation: projectMembers.allocation
		})
		.from(projectMembers)
		.innerJoin(employees, eq(employees.id, projectMembers.employeeId))
		.where(eq(projectMembers.projectId, id))
		.orderBy(asc(projectMembers.role), asc(employees.fullName));
	const canManage = canRunProjects(access);
	const people = canManage
		? await tx
				.select({ id: employees.id, name: employees.fullName })
				.from(employees)
				.where(ne(employees.status, 'exited'))
				.orderBy(asc(employees.fullName))
		: [];
	return { project, members, people, canManage };
}

export const projectAttachments: AttachmentRules = {
	async canRead(tx, access, id) {
		const scope = await resolveScope(tx, access, 'project.read');
		const [p] = await tx
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.id, id), visible(scope)));
		return !!p;
	},
	canEdit: async (_tx, access) => canRunProjects(access)
};
