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
	memberships,
	tenantSettings
} from './db/schema';
import { ImportFailed, MAX_EXPORT_ROWS, unformula, type ImportRowError } from './csv';
import { FK_VIOLATION, pgCode, UNIQUE_VIOLATION } from './db/errors';
import { containsPattern } from './db/like';
import { startChecklists } from './checklists';
import { accrue } from './leave';
import { AppError } from './errors';
import { advisoryLock, LOCK } from './locks';
import { notify, sendAll } from './notifications';
import type { Access } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import type { TenantCtx, Tx } from './tenancy';
import { withTenant } from './tenancy';

export const blank = <T extends z.ZodType>(schema: T) =>
	z.union([z.literal(''), schema]).transform((v) => (v === '' ? null : v));
export const text = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Keep it under ${max} characters.`)
		.transform((v) => v || null);
export const date = blank(z.iso.date('Enter a valid date.'));
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
export const BANK_KEYS = ['bankName', 'bankAccountName', 'bankAccountNumber'] as const;

export async function bankChangeAlert(tx: Tx, tenantId: string, employeeId: string, tenantSlug: string) {
	const owners = await tx
		.select({ id: memberships.id })
		.from(memberships)
		.where(eq(memberships.employeeId, employeeId));
	return notify(
		tx,
		tenantId,
		owners.map((o) => o.id),
		{
			category: 'profile',
			title: 'Your bank details were changed',
			body: 'The bank account on your employee record was changed. If you did not expect this, tell HR right away.',
			link: `employees/${employeeId}`
		},
		tenantSlug,
		{ ignoreOptOut: true }
	);
}
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
	status: 'Status',
	probationEndDate: 'Probation end'
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

export async function lockEmployee(tx: Tx, access: Access, employeeId: string) {
	const id = z.uuid().safeParse(employeeId);
	const [e] = id.success ? await tx.select().from(employees).where(eq(employees.id, id.data)).for('update') : [];
	if (!e || !inScope(await resolveScope(tx, access, 'employee.read'), e.id))
		throw new AppError('not_found', 'That employee does not exist.', 404);
	return e;
}

async function nextCodes(tx: Tx, tenantId: string, count: number): Promise<string[]> {
	const [{ value }] = await tx
		.insert(counters)
		.values({ tenantId, name: 'employee_code', value: count })
		.onConflictDoUpdate({
			target: [counters.tenantId, counters.name],
			set: { value: sql`${counters.value} + ${count}` }
		})
		.returning({ value: counters.value });
	const [s] = await tx.select({ prefix: tenantSettings.employeeCodePrefix }).from(tenantSettings);
	return Array.from(
		{ length: count },
		(_, i) => `${s?.prefix ?? 'EMP-'}${String(value - count + 1 + i).padStart(4, '0')}`
	);
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
		status: (values.status as string) ?? null,
		probationEndDate: (values.probationEndDate as string) ?? null
	};
}

const INSERT_CHUNK = 500;

async function insertEmployees(
	tx: Tx,
	tenantId: string,
	access: Access,
	people: { id: string; form: EmployeeForm; line?: number }[]
): Promise<string[]> {
	const codes = await nextCodes(tx, tenantId, people.length);
	const rows = people.map(({ id, form }, i) => ({
		id,
		tenantId,
		code: codes[i],
		...baseSchema.parse(form),
		...sensitiveSchema.parse(Object.fromEntries(SENSITIVE_KEYS.filter((k) => k in form).map((k) => [k, form[k]])))
	}));
	for (let i = 0; i < rows.length; i += INSERT_CHUNK)
		await tx
			.insert(employees)
			.values(rows.slice(i, i + INSERT_CHUNK))
			.catch(friendly);
	const refuse = (denied: typeof people, code: string, message: string) => {
		if (!denied.length) return;
		if (denied.every((p) => p.line)) throw new ImportFailed(denied.map((p) => ({ line: p.line!, message })));
		throw new AppError(code, message, 403);
	};
	const create = await resolveScope(tx, access, 'employee.create');
	refuse(
		people.filter((p) => !inScope(create, p.id)),
		'out_of_scope',
		'You can only add people within your own scope.'
	);
	const withSensitive = people.filter((p) => hasSensitive(p.form));
	if (withSensitive.length) {
		const sensitive = await resolveScope(tx, access, 'employee.sensitive.update');
		refuse(
			withSensitive.filter((p) => !inScope(sensitive, p.id)),
			'sensitive_denied',
			'You cannot set identity or bank details.'
		);
	}
	const ids = rows.map((r) => r.id);
	for (const r of rows)
		if (r.status === 'onboarding') await startChecklists(tx, tenantId, r.id, 'onboarding', r.joinDate);
	await accrue(tx, tenantId, ids);
	return ids;
}

export const insertEmployee = async (tx: Tx, tenantId: string, access: Access, form: EmployeeForm): Promise<string> =>
	(await insertEmployees(tx, tenantId, access, [{ id: crypto.randomUUID(), form }]))[0];

export const createEmployee = (ctx: TenantCtx, access: Access, form: EmployeeForm): Promise<string> =>
	withTenant(ctx, (tx) => insertEmployee(tx, ctx.tenantId, access, form));

export async function updateEmployee(
	ctx: TenantCtx,
	access: Access,
	employeeId: string,
	form: EmployeeForm,
	tenantSlug: string
) {
	const targetId = z.uuid().parse(employeeId);
	const input = baseSchema.parse(form);
	const sensitive = sensitiveSchema.parse(
		Object.fromEntries(SENSITIVE_KEYS.filter((k) => k in form).map((k) => [k, form[k]]))
	);
	const mails = await withTenant(ctx, async (tx) => {
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
		const bankChanged = sensitiveChanged && BANK_KEYS.some((k) => k in sensitive && sensitive[k] !== current[k]);
		return bankChanged ? bankChangeAlert(tx, ctx.tenantId, targetId, tenantSlug) : [];
	});
	await sendAll(mails);
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

async function listFilter(tx: Tx, access: Access, f: z.infer<typeof listSchema>) {
	const scope = await resolveScope(tx, access, 'employee.read');
	const where: SQL[] = [scopeWhere(scope, employees.id)];
	if (f.q) {
		const like = containsPattern(f.q);
		where.push(or(ilike(employees.fullName, like), ilike(employees.code, like), ilike(employees.workEmail, like))!);
	}
	if (f.department) where.push(eq(employees.departmentId, f.department));
	if (f.status) where.push(eq(employees.status, f.status));
	return and(...where);
}

export async function listEmployees(tx: Tx, access: Access, raw: Record<string, string | null>) {
	const f = listSchema.parse(raw);
	const filter = await listFilter(tx, access, f);
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

export const CSV_COLUMNS = [
	'full_name',
	'work_email',
	'personal_email',
	'phone',
	'date_of_birth',
	'gender',
	'department',
	'designation',
	'grade',
	'branch',
	'manager_email',
	'employment_type',
	'status',
	'join_date',
	'probation_end_date'
] as const;

export async function exportEmployees(tx: Tx, access: Access, raw: Record<string, string | null>) {
	const f = listSchema.parse(raw);
	const rows = await tx
		.select({
			code: employees.code,
			fullName: employees.fullName,
			workEmail: employees.workEmail,
			personalEmail: employees.personalEmail,
			phone: employees.phone,
			dateOfBirth: employees.dateOfBirth,
			gender: employees.gender,
			department: departments.name,
			designation: designations.name,
			grade: grades.name,
			branch: branches.name,
			managerEmail: manager.workEmail,
			employmentType: employees.employmentType,
			status: employees.status,
			joinDate: employees.joinDate,
			probationEndDate: employees.probationEndDate
		})
		.from(employees)
		.leftJoin(departments, eq(departments.id, employees.departmentId))
		.leftJoin(designations, eq(designations.id, employees.designationId))
		.leftJoin(grades, eq(grades.id, employees.gradeId))
		.leftJoin(branches, eq(branches.id, employees.branchId))
		.leftJoin(manager, eq(manager.id, employees.managerId))
		.where(await listFilter(tx, access, f))
		.orderBy(...SORTS[f.sort])
		.limit(MAX_EXPORT_ROWS + 1);
	return [['code', ...CSV_COLUMNS], ...rows.map((r) => Object.values(r))];
}

export const MAX_IMPORT_ROWS = 2000;

export async function importEmployees(ctx: TenantCtx, access: Access, table: string[][]): Promise<number> {
	const [header, ...body] = table;
	const cols = (header ?? []).map((h) => h.trim().toLowerCase());
	const unknown = cols.filter((c) => !(CSV_COLUMNS as readonly string[]).includes(c));
	const missing = ['full_name', 'employment_type', 'status', 'join_date'].filter((c) => !cols.includes(c));
	if (unknown.length || missing.length || new Set(cols).size !== cols.length)
		throw new ImportFailed([
			{
				line: 1,
				message: `Header must use these columns: ${CSV_COLUMNS.join(', ')} (full_name, employment_type, status and join_date are required).`
			}
		]);
	if (!body.length) throw new ImportFailed([{ line: 2, message: 'The file has no rows to import.' }]);
	if (body.length > MAX_IMPORT_ROWS)
		throw new ImportFailed([{ line: 1, message: `Import at most ${MAX_IMPORT_ROWS} rows at a time.` }]);

	return withTenant(ctx, async (tx) => {
		const byName = async (table: typeof departments | typeof designations | typeof grades | typeof branches) =>
			new Map(
				(await tx.select({ id: table.id, name: table.name }).from(table)).map((r) => [r.name.toLowerCase(), r.id])
			);
		const lookups = {
			department: ['departmentId', await byName(departments)],
			designation: ['designationId', await byName(designations)],
			grade: ['gradeId', await byName(grades)],
			branch: ['branchId', await byName(branches)]
		} as const;
		const emails = new Map(
			(await tx.select({ id: employees.id, email: employees.workEmail }).from(employees))
				.filter((r) => r.email)
				.map((r) => [r.email!.toLowerCase(), r.id])
		);
		const errors: ImportRowError[] = [];
		const valid: { id: string; form: EmployeeForm; line: number }[] = [];
		for (const [i, cells] of body.entries()) {
			const line = i + 2;
			const v = Object.fromEntries(cols.map((c, j) => [c, unformula(cells[j] ?? '')]));
			const form: EmployeeForm = Object.fromEntries(
				Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, ''])
			);
			Object.assign(form, {
				fullName: v.full_name ?? '',
				workEmail: v.work_email ?? '',
				personalEmail: v.personal_email ?? '',
				phone: v.phone ?? '',
				dateOfBirth: v.date_of_birth ?? '',
				gender: v.gender ?? '',
				employmentType: v.employment_type ?? '',
				status: v.status ?? '',
				joinDate: v.join_date ?? '',
				probationEndDate: v.probation_end_date ?? ''
			});
			const problems: string[] = [];
			for (const [col, [key, map]] of Object.entries(lookups)) {
				if (!v[col]) continue;
				const found = map.get(v[col].toLowerCase());
				if (found) form[key] = found;
				else problems.push(`Unknown ${col} "${v[col]}".`);
			}
			if (v.manager_email) {
				const found = emails.get(v.manager_email.toLowerCase());
				if (found) form.managerId = found;
				else
					problems.push(`No employee has the manager email "${v.manager_email}" (list managers before their reports).`);
			}
			if (problems.length) {
				errors.push({ line, message: problems.join(' ') });
				continue;
			}
			const parsed = baseSchema.safeParse(form);
			const email = form.workEmail.trim().toLowerCase();
			if (!parsed.success)
				errors.push({
					line,
					message: parsed.error.issues
						.map((x) => `${String(x.path[0]).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}: ${x.message}`)
						.join(' ')
				});
			else if (email && emails.has(email))
				errors.push({ line, message: 'Another employee already uses that work email.' });
			else {
				const id = crypto.randomUUID();
				if (email) emails.set(email, id);
				valid.push({ id, form, line });
			}
		}
		if (errors.length) throw new ImportFailed(errors);
		await insertEmployees(tx, ctx.tenantId, access, valid);
		return body.length;
	});
}
