import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
	branches,
	counters,
	departments,
	designations,
	EMPLOYEE_STATUSES,
	EMPLOYMENT_TYPES,
	employeeHistory,
	employees,
	GENDERS,
	grades,
	tenantSettings
} from './db/schema';
import { FK_VIOLATION, pgCode, UNIQUE_VIOLATION } from './db/errors';
import { AppError } from './errors';
import { advisoryLock, LOCK } from './locks';
import type { Access } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import type { TenantCtx, Tx } from './tenancy';
import { withTenant } from './tenancy';

const blank = <T extends z.ZodType>(schema: T) =>
	z.union([z.literal(''), schema]).transform((v) => (v === '' ? null : v));
const text = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Keep it under ${max} characters.`)
		.transform((v) => v || null);
const date = blank(z.iso.date('Enter a valid date.'));
const id = blank(z.uuid());

export const PROFILE_FIELDS = {
	fullName: z.string().trim().min(1, 'Enter the full name.').max(160),
	workEmail: blank(z.email('Enter a valid work email.')),
	personalEmail: blank(z.email('Enter a valid personal email.')),
	phone: text(30),
	dateOfBirth: date,
	gender: blank(z.enum(GENDERS)),
	bloodGroup: blank(z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])),
	presentAddress: text(500),
	permanentAddress: text(500)
};

export const EMPLOYMENT_FIELDS = {
	departmentId: id,
	designationId: id,
	gradeId: id,
	branchId: id,
	managerId: id,
	employmentType: z.enum(EMPLOYMENT_TYPES),
	joinDate: z.iso.date('Enter a valid join date.'),
	probationEndDate: date,
	confirmationDate: date,
	status: z.enum(EMPLOYEE_STATUSES.filter((s) => s !== 'exited') as ['onboarding', 'probation', 'active', 'notice'], {
		message: 'Use the exit process to mark someone as exited.'
	})
};

export const SENSITIVE_FIELDS = {
	nationalId: text(40),
	passportNumber: text(40),
	taxId: text(40),
	bankName: text(120),
	bankAccountName: text(160),
	bankAccountNumber: text(40)
};

const SENSITIVE_KEYS = Object.keys(SENSITIVE_FIELDS) as (keyof typeof SENSITIVE_FIELDS)[];
const baseSchema = z.object({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS });
const sensitiveSchema = z.object(SENSITIVE_FIELDS).partial();

export type EmployeeForm = Record<string, string>;

const TRACKED = {
	departmentId: 'Department',
	designationId: 'Designation',
	gradeId: 'Grade',
	branchId: 'Branch',
	managerId: 'Manager',
	employmentType: 'Employment type',
	status: 'Status'
} as const;

const manager = alias(employees, 'manager');

function friendly(err: unknown): never {
	const code = pgCode(err);
	if (code === UNIQUE_VIOLATION)
		throw new AppError('duplicate_email', 'Another employee already uses that work email.', 409);
	if (code === FK_VIOLATION)
		throw new AppError('invalid_reference', 'Pick an existing department, designation, grade, branch or manager.', 400);
	throw err;
}

const hasSensitive = (form: EmployeeForm) => SENSITIVE_KEYS.some((k) => k in form);

async function nextCode(tx: Tx, tenantId: string): Promise<string> {
	const [{ value }] = await tx
		.insert(counters)
		.values({ tenantId, name: 'employee_code', value: 1 })
		.onConflictDoUpdate({ target: [counters.tenantId, counters.name], set: { value: sql`${counters.value} + 1` } })
		.returning({ value: counters.value });
	const [s] = await tx.select({ prefix: tenantSettings.employeeCodePrefix }).from(tenantSettings);
	return `${s?.prefix ?? 'EMP-'}${String(value).padStart(4, '0')}`;
}

async function checkManager(tx: Tx, tenantId: string, employeeId: string, managerId: string | null) {
	if (!managerId) return;
	await advisoryLock(tx, LOCK.orgTree, `mgr:${tenantId}`);
	const loop = await tx.execute<{ id: string }>(sql`
		with recursive up(id, depth) as (
			select ${managerId}::uuid, 0
			union all
			select e.manager_id, up.depth + 1 from employees e join up on e.id = up.id
			where e.manager_id is not null and up.depth < 50
		)
		select id from up where id = ${employeeId}::uuid limit 1`);
	if (loop.length) throw new AppError('manager_cycle', 'Someone cannot report to a person who reports to them.', 409);
}

async function labels(tx: Tx, values: Record<string, unknown>): Promise<Record<string, string | null>> {
	const ids = (k: string) => (values[k] as string | null) ?? null;
	const name = async (table: typeof departments | typeof designations | typeof grades | typeof branches, k: string) => {
		const v = ids(k);
		if (!v) return null;
		const [r] = await tx.select({ name: table.name }).from(table).where(eq(table.id, v));
		return r?.name ?? v;
	};
	const managerLabel = async () => {
		const v = ids('managerId');
		if (!v) return null;
		const [r] = await tx
			.select({ name: employees.fullName, code: employees.code })
			.from(employees)
			.where(eq(employees.id, v));
		return r ? `${r.name} (${r.code})` : v;
	};
	return {
		departmentId: await name(departments, 'departmentId'),
		designationId: await name(designations, 'designationId'),
		gradeId: await name(grades, 'gradeId'),
		branchId: await name(branches, 'branchId'),
		managerId: await managerLabel(),
		employmentType: (values.employmentType as string) ?? null,
		status: (values.status as string) ?? null
	};
}

export async function createEmployee(ctx: TenantCtx, access: Access, form: EmployeeForm): Promise<string> {
	const input = baseSchema.parse(form);
	const sensitive = sensitiveSchema.parse(
		Object.fromEntries(SENSITIVE_KEYS.filter((k) => k in form).map((k) => [k, form[k]]))
	);
	return withTenant(ctx, async (tx) => {
		const code = await nextCode(tx, ctx.tenantId);
		const [row] = await tx
			.insert(employees)
			.values({ tenantId: ctx.tenantId, code, ...input, ...sensitive })
			.returning({ id: employees.id })
			.catch(friendly);
		if (!inScope(await resolveScope(tx, access, 'employee.create'), row.id))
			throw new AppError('out_of_scope', 'You can only add people within your own scope.', 403);
		if (hasSensitive(form) && !inScope(await resolveScope(tx, access, 'employee.sensitive.update'), row.id))
			throw new AppError('sensitive_denied', 'You cannot set identity or bank details.', 403);
		return row.id;
	});
}

export async function updateEmployee(ctx: TenantCtx, access: Access, employeeId: string, form: EmployeeForm) {
	const targetId = z.uuid().parse(employeeId);
	const input = baseSchema.parse(form);
	const sensitive = sensitiveSchema.parse(
		Object.fromEntries(SENSITIVE_KEYS.filter((k) => k in form).map((k) => [k, form[k]]))
	);
	await withTenant(ctx, async (tx) => {
		const [current] = await tx.select().from(employees).where(eq(employees.id, targetId)).for('update');
		if (!current || !inScope(await resolveScope(tx, access, 'employee.read'), targetId))
			throw new AppError('not_found', 'That employee does not exist.', 404);
		if (current.status === 'exited')
			throw new AppError('exited', 'Rehire this person before changing their record.', 409);
		const updateScope = await resolveScope(tx, access, 'employee.update');
		if (!inScope(updateScope, targetId)) throw new AppError('forbidden', 'You cannot edit this employee.', 403);
		const sensitiveChanged = SENSITIVE_KEYS.some((k) => k in sensitive && sensitive[k] !== current[k]);
		if (sensitiveChanged && !inScope(await resolveScope(tx, access, 'employee.sensitive.update'), targetId))
			throw new AppError('sensitive_denied', 'You cannot change identity or bank details.', 403);
		if (input.managerId !== current.managerId) await checkManager(tx, ctx.tenantId, targetId, input.managerId);

		await tx
			.update(employees)
			.set({ ...input, ...(sensitiveChanged ? sensitive : {}) })
			.where(eq(employees.id, targetId))
			.catch(friendly);

		const changed = (Object.keys(TRACKED) as (keyof typeof TRACKED)[]).filter((k) => input[k] !== current[k]);
		if (changed.length) {
			const [before, after] = [await labels(tx, current), await labels(tx, input)];
			await tx.insert(employeeHistory).values(
				changed.map((field) => ({
					tenantId: ctx.tenantId,
					employeeId: targetId,
					field,
					oldValue: before[field],
					newValue: after[field],
					changedByUserId: ctx.userId ?? null
				}))
			);
		}
		if (!inScope(await resolveScope(tx, access, 'employee.update'), targetId))
			throw new AppError('out_of_scope', 'That change would move this person outside your scope.', 403);
	});
}

const SORTS = {
	code: [asc(employees.code)],
	name: [asc(employees.fullName), asc(employees.code)],
	joined: [desc(employees.joinDate), asc(employees.code)]
} as const;

export const listSchema = z.object({
	q: z.string().trim().max(100).catch(''),
	department: z.uuid().or(z.literal('')).catch(''),
	status: z.enum(EMPLOYEE_STATUSES).or(z.literal('')).catch(''),
	sort: z.enum(['code', 'name', 'joined']).catch('name'),
	page: z.coerce.number().int().min(1).max(10_000).catch(1)
});

export const PAGE_SIZE = 25;

export async function listEmployees(tx: Tx, access: Access, raw: Record<string, string | null>) {
	const f = listSchema.parse(raw);
	const scope = await resolveScope(tx, access, 'employee.read');
	const where: SQL[] = [scopeWhere(scope, employees.id)];
	if (f.q) {
		const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		where.push(or(ilike(employees.fullName, like), ilike(employees.code, like), ilike(employees.workEmail, like))!);
	}
	if (f.department) where.push(eq(employees.departmentId, f.department));
	if (f.status) where.push(eq(employees.status, f.status));
	const filter = and(...where);
	const [rows, [{ total }]] = await Promise.all([
		tx
			.select({
				id: employees.id,
				code: employees.code,
				fullName: employees.fullName,
				workEmail: employees.workEmail,
				status: employees.status,
				joinDate: employees.joinDate,
				department: departments.name,
				designation: designations.name
			})
			.from(employees)
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.leftJoin(designations, eq(designations.id, employees.designationId))
			.where(filter)
			.orderBy(...SORTS[f.sort])
			.limit(PAGE_SIZE)
			.offset((f.page - 1) * PAGE_SIZE),
		tx.select({ total: count() }).from(employees).where(filter)
	]);
	return { filters: f, rows, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

export async function getEmployee(tx: Tx, access: Access, employeeId: string) {
	const targetId = z.uuid().safeParse(employeeId);
	if (!targetId.success) return null;
	if (!inScope(await resolveScope(tx, access, 'employee.read'), targetId.data)) return null;
	const [row] = await tx
		.select({
			employee: employees,
			department: departments.name,
			designation: designations.name,
			grade: grades.name,
			branch: branches.name,
			managerName: manager.fullName,
			managerCode: manager.code
		})
		.from(employees)
		.leftJoin(departments, eq(departments.id, employees.departmentId))
		.leftJoin(designations, eq(designations.id, employees.designationId))
		.leftJoin(grades, eq(grades.id, employees.gradeId))
		.leftJoin(branches, eq(branches.id, employees.branchId))
		.leftJoin(manager, eq(manager.id, employees.managerId))
		.where(eq(employees.id, targetId.data));
	if (!row) return null;
	const sensitiveRead = inScope(await resolveScope(tx, access, 'employee.sensitive.read'), targetId.data);
	const { employee, ...names } = row;
	const safe = Object.fromEntries(Object.entries(employee).filter(([k]) => !SENSITIVE_KEYS.includes(k as never)));
	const history = await tx
		.select({
			field: employeeHistory.field,
			oldValue: employeeHistory.oldValue,
			newValue: employeeHistory.newValue,
			at: employeeHistory.createdAt
		})
		.from(employeeHistory)
		.where(eq(employeeHistory.employeeId, targetId.data))
		.orderBy(desc(employeeHistory.createdAt))
		.limit(50);
	return {
		employee: safe as Omit<typeof employee, (typeof SENSITIVE_KEYS)[number]>,
		sensitive: sensitiveRead ? Object.fromEntries(SENSITIVE_KEYS.map((k) => [k, employee[k]])) : null,
		names,
		history: history.map((h) => ({ ...h, label: TRACKED[h.field as keyof typeof TRACKED] ?? h.field })),
		canUpdate:
			inScope(await resolveScope(tx, access, 'employee.update'), targetId.data) && employee.status !== 'exited',
		canUpdateSensitive: inScope(await resolveScope(tx, access, 'employee.sensitive.update'), targetId.data)
	};
}

export async function employeeChoices(tx: Tx) {
	const [d, des, g, b, m] = await Promise.all([
		tx.select({ id: departments.id, name: departments.name }).from(departments).orderBy(asc(departments.name)),
		tx.select({ id: designations.id, name: designations.name }).from(designations).orderBy(asc(designations.name)),
		tx.select({ id: grades.id, name: grades.name }).from(grades).orderBy(asc(grades.rank), asc(grades.name)),
		tx.select({ id: branches.id, name: branches.name }).from(branches).orderBy(asc(branches.name)),
		tx
			.select({ id: employees.id, name: sql<string>`${employees.fullName} || ' (' || ${employees.code} || ')'` })
			.from(employees)
			.where(sql`${employees.status} <> 'exited'`)
			.orderBy(asc(employees.fullName))
	]);
	return { departments: d, designations: des, grades: g, branches: b, managers: m };
}
