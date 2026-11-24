import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { taka } from '../money';
import { activeMemberships } from './approval-chain';
import { auditEvent } from './audit';
import {
	branches,
	departments,
	designations,
	employees,
	employeeSalaries,
	LETTER_KINDS,
	letters,
	letterTemplates
} from './db/schema';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { advisoryLock, LOCK } from './locks';
import { log } from './log';
import type { Mail } from './mail';
import { notify } from './notifications';
import { longDate, renderLetterPdf } from './letter-pdf';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere, type ScopeSet } from './rbac/scope';
import { salaryCtx } from './salaries';
import { deleteObject, getObject, putObject } from './storage';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
export type LetterKind = (typeof LETTER_KINDS)[number];

export const LETTER_PLACEHOLDERS = [
	'company.name',
	'today',
	'employee.name',
	'employee.code',
	'employee.designation',
	'employee.department',
	'employee.branch',
	'employee.join_date',
	'employee.probation_end',
	'employee.confirmation_date',
	'employee.exit_date',
	'salary.gross'
] as const;

const SIGN_OFF = '\n\nSincerely,\n\nHuman Resources\n{{company.name}}';
export const DEFAULT_LETTER_TEMPLATES: { kind: LetterKind; name: string; subject: string; body: string }[] = [
	{
		kind: 'offer',
		name: 'Offer letter',
		subject: 'Offer of employment',
		body: `Dear {{employee.name}},\n\nWe are pleased to offer you the position of {{employee.designation}} in the {{employee.department}} department at {{company.name}}, starting on {{employee.join_date}}, with a monthly gross salary of BDT {{salary.gross}}.\n\nPlease confirm your acceptance by signing a copy of this letter.${SIGN_OFF}`
	},
	{
		kind: 'appointment',
		name: 'Appointment letter',
		subject: 'Letter of appointment',
		body: `Dear {{employee.name}},\n\nWe are pleased to appoint you as {{employee.designation}} at {{company.name}} with effect from {{employee.join_date}}. Your employee ID is {{employee.code}}. You will be on probation until {{employee.probation_end}}.${SIGN_OFF}`
	},
	{
		kind: 'confirmation',
		name: 'Confirmation letter',
		subject: 'Confirmation of employment',
		body: `Dear {{employee.name}},\n\nWe are pleased to confirm your employment as {{employee.designation}} with effect from {{employee.confirmation_date}}. Thank you for your contribution so far.${SIGN_OFF}`
	},
	{
		kind: 'increment',
		name: 'Increment letter',
		subject: 'Salary increment',
		body: `Dear {{employee.name}},\n\nIn recognition of your performance, your monthly gross salary has been revised to BDT {{salary.gross}}.${SIGN_OFF}`
	},
	{
		kind: 'experience',
		name: 'Experience certificate',
		subject: 'Experience certificate',
		body: `To whom it may concern,\n\nThis is to certify that {{employee.name}} (ID {{employee.code}}) worked at {{company.name}} as {{employee.designation}} from {{employee.join_date}} to {{employee.exit_date}}.\n\nWe wish them every success.${SIGN_OFF}`
	},
	{
		kind: 'salary_certificate',
		name: 'Salary certificate',
		subject: 'Salary certificate',
		body: `To whom it may concern,\n\nThis is to certify that {{employee.name}} (ID {{employee.code}}) has been working at {{company.name}} as {{employee.designation}} since {{employee.join_date}}, and currently draws a monthly gross salary of BDT {{salary.gross}}.${SIGN_OFF}`
	}
];

export const seedLetterTemplates = (tx: Tx, tenantId: string) =>
	tx
		.insert(letterTemplates)
		.values(DEFAULT_LETTER_TEMPLATES.map((t) => ({ tenantId, ...t })))
		.onConflictDoNothing();

const PLACEHOLDER = /\{\{\s*([a-z_.]+)\s*\}\}/g;
const UNFILLED = /\{\{.*?\}\}/;
const known = new Set<string>(LETTER_PLACEHOLDERS);
const bodyText = z.string().trim().min(1, 'Write the letter.').max(20000, 'Keep the letter under 20000 characters.');
const subjectText = z.string().trim().min(1, 'Add a subject.').max(160, 'Keep the subject under 160 characters.');

const templateSchema = z.object({
	templateId: z
		.union([z.literal(''), z.uuid()])
		.transform((v) => v || null)
		.prefault(''),
	kind: z.enum(LETTER_KINDS, 'Choose the kind of letter.'),
	name: z.string().trim().min(1, 'Name the template.').max(80, 'Keep the name under 80 characters.'),
	subject: subjectText,
	body: bodyText.refine((b) => [...b.matchAll(PLACEHOLDER)].every((m) => known.has(m[1])), {
		message: 'Use only the placeholders listed under the editor.'
	}),
	active: z.preprocess((v) => v === 'on' || v === true, z.boolean())
});
const issueSchema = z.object({
	employeeId: z.uuid({ error: 'Choose an employee.' }),
	templateId: z.uuid({ error: 'Choose a template.' }),
	subject: subjectText.refine((v) => !UNFILLED.test(v), 'Fill in every {{placeholder}} before issuing.'),
	body: bodyText.refine((v) => !UNFILLED.test(v), 'Fill in every {{placeholder}} before issuing.')
});

export const canSetUpLetters = (access: Access) => scopesOf(access, 'letter.issue').includes('all');
const notFound = () => new AppError('not_found', 'That letter does not exist.', 404);
const noEmployee = () => new AppError('not_found', 'That employee does not exist.', 404);

export async function saveTemplate(m: Member, raw: Record<string, string>) {
	const { templateId, ...input } = templateSchema.parse(raw);
	if (!canSetUpLetters(m.access))
		throw new AppError('forbidden', 'Only people who issue letters for everyone can change templates.', 403);
	return withTenant(userCtx(m), async (tx) => {
		const clash = (err: unknown) => {
			if (pgCode(err) === UNIQUE_VIOLATION)
				throw new AppError('name_exists', 'Another template already uses that name.', 409);
			throw err;
		};
		if (templateId) {
			const [t] = await tx
				.update(letterTemplates)
				.set(input)
				.where(eq(letterTemplates.id, templateId))
				.returning({ id: letterTemplates.id })
				.catch(clash);
			if (!t) throw new AppError('not_found', 'That template does not exist.', 404);
			return t.id;
		}
		const [t] = await tx
			.insert(letterTemplates)
			.values({ tenantId: m.tenant.id, ...input })
			.returning({ id: letterTemplates.id })
			.catch(clash);
		return t.id;
	});
}

export const templateList = (tx: Tx, activeOnly = false) =>
	tx
		.select()
		.from(letterTemplates)
		.where(activeOnly ? eq(letterTemplates.active, true) : undefined)
		.orderBy(desc(letterTemplates.active), asc(letterTemplates.name));

async function placeholderValues(tx: Tx, m: Member, employeeId: string) {
	const [e] = await tx
		.select({
			name: employees.fullName,
			code: employees.code,
			designation: designations.name,
			department: departments.name,
			branch: branches.name,
			joinDate: employees.joinDate,
			probationEnd: employees.probationEndDate,
			confirmationDate: employees.confirmationDate,
			exitDate: employees.exitDate
		})
		.from(employees)
		.leftJoin(designations, eq(designations.id, employees.designationId))
		.leftJoin(departments, eq(departments.id, employees.departmentId))
		.leftJoin(branches, eq(branches.id, employees.branchId))
		.where(eq(employees.id, employeeId));
	if (!e) throw noEmployee();
	const seesSalary = inScope(await resolveScope(tx, m.access, 'salary.read'), employeeId);
	const salary = seesSalary
		? await withTenant(salaryCtx(m), (stx) =>
				stx
					.select({ gross: employeeSalaries.gross })
					.from(employeeSalaries)
					.where(and(eq(employeeSalaries.employeeId, employeeId), isNull(employeeSalaries.effectiveTo)))
			)
		: [];
	const values: Record<string, string | null> = {
		'company.name': m.tenant.name,
		today: longDate(await tenantToday(tx)),
		'employee.name': e.name,
		'employee.code': e.code,
		'employee.designation': e.designation,
		'employee.department': e.department,
		'employee.branch': e.branch,
		'employee.join_date': longDate(e.joinDate),
		'employee.probation_end': longDate(e.probationEnd),
		'employee.confirmation_date': longDate(e.confirmationDate),
		'employee.exit_date': longDate(e.exitDate),
		'salary.gross': salary[0] ? taka(salary[0].gross) : null
	};
	return values;
}

const issuable = (scope: ScopeSet, access: Access, employeeId: string) =>
	inScope(scope, employeeId) && (scope.kind === 'all' || employeeId !== access.employeeId);

async function issuableEmployee(tx: Tx, access: Access, employeeId: string) {
	const [e] = await tx
		.select({ id: employees.id, name: employees.fullName })
		.from(employees)
		.where(eq(employees.id, employeeId));
	if (!e || !issuable(await resolveScope(tx, access, 'letter.issue'), access, e.id)) throw noEmployee();
	return e;
}

export async function letterPreview(m: Member, employeeId: string, templateId: string) {
	if (!z.uuid().safeParse(employeeId).success) throw noEmployee();
	if (!z.uuid().safeParse(templateId).success) throw new AppError('not_found', 'That template does not exist.', 404);
	return withTenant(userCtx(m), async (tx) => {
		const e = await issuableEmployee(tx, m.access, employeeId);
		const [t] = await tx
			.select()
			.from(letterTemplates)
			.where(and(eq(letterTemplates.id, templateId), eq(letterTemplates.active, true)));
		if (!t) throw new AppError('not_found', 'That template does not exist.', 404);
		const values = await placeholderValues(tx, m, e.id);
		const fill = (text: string) => text.replace(PLACEHOLDER, (raw, key: string) => values[key] ?? raw);
		return { employee: e, template: { id: t.id, name: t.name }, subject: fill(t.subject), body: fill(t.body) };
	});
}

export async function issueLetter(m: Member, raw: Record<string, string>): Promise<{ id: string; mails: Mail[] }> {
	const input = issueSchema.parse(raw);
	let storageKey: string | null = null;
	try {
		return await withTenant(userCtx(m), async (tx) => {
			const e = await issuableEmployee(tx, m.access, input.employeeId);
			const [t] = await tx
				.select({ id: letterTemplates.id, kind: letterTemplates.kind })
				.from(letterTemplates)
				.where(and(eq(letterTemplates.id, input.templateId), eq(letterTemplates.active, true)));
			if (!t) throw new AppError('not_found', 'That template does not exist.', 404);
			await advisoryLock(tx, LOCK.letters, m.tenant.id);
			const [{ number }] = await tx
				.select({ number: sql<number>`coalesce(max(${letters.number}), 0)::int + 1` })
				.from(letters);
			const issuedOn = await tenantToday(tx);
			const bytes = await renderLetterPdf({ company: m.tenant.name, number, issuedOn, ...input });
			storageKey = `t/${m.tenant.id}/letters/${randomUUID()}`;
			await putObject(storageKey, bytes, 'application/pdf');
			const [l] = await tx
				.insert(letters)
				.values({
					tenantId: m.tenant.id,
					number,
					employeeId: e.id,
					templateId: t.id,
					kind: t.kind,
					subject: input.subject,
					body: input.body,
					fileName: `${
						input.subject
							.replace(/[^\w -]+/g, '')
							.trim()
							.slice(0, 80) || 'letter'
					}.pdf`,
					sizeBytes: bytes.byteLength,
					sha256: createHash('sha256').update(bytes).digest('hex'),
					storageKey,
					issuedOn,
					issuedByUserId: m.user.userId
				})
				.returning({ id: letters.id });
			const to = (await activeMemberships(tx, e.id)).filter((id) => id !== m.access.membershipId);
			const mails = await notify(
				tx,
				m.tenant.id,
				to,
				{ category: 'letters', title: `A letter was issued to you: ${input.subject}`, link: 'letters' },
				m.tenant.slug
			);
			return { id: l.id, mails };
		});
	} catch (err) {
		const key = storageKey;
		if (key)
			await deleteObject(key).catch((e) => log.error({ err: e, storageKey: key }, 'orphan letter cleanup failed'));
		throw err;
	}
}

const letterFields = {
	id: letters.id,
	number: letters.number,
	kind: letters.kind,
	subject: letters.subject,
	issuedOn: letters.issuedOn,
	employeeId: letters.employeeId,
	employee: employees.fullName,
	code: employees.code
};

export async function letterBoard(tx: Tx, access: Access) {
	const scope = await resolveScope(tx, access, 'letter.issue');
	const me = access.employeeId;
	const mine = me
		? await tx
				.select(letterFields)
				.from(letters)
				.innerJoin(employees, eq(employees.id, letters.employeeId))
				.where(eq(letters.employeeId, me))
				.orderBy(desc(letters.number))
		: [];
	if (scope.kind === 'ids' && !scope.ids.some((id) => id !== me))
		return { mine, issued: null, people: [], templates: [] };
	const others = scope.kind === 'all' || !me ? sql`true` : ne(employees.id, me);
	const [issued, people, templates] = await Promise.all([
		tx
			.select(letterFields)
			.from(letters)
			.innerJoin(employees, eq(employees.id, letters.employeeId))
			.where(and(scopeWhere(scope, letters.employeeId), others))
			.orderBy(desc(letters.number))
			.limit(500),
		tx
			.select({ id: employees.id, name: employees.fullName, code: employees.code })
			.from(employees)
			.where(and(scopeWhere(scope, employees.id), others))
			.orderBy(asc(employees.fullName)),
		templateList(tx, true)
	]);
	return { mine, issued, people, templates: templates.map((t) => ({ id: t.id, name: t.name })) };
}

export async function openLetter(m: Member, id: string) {
	if (!z.uuid().safeParse(id).success) throw notFound();
	const ctx = userCtx(m);
	const l = await withTenant(ctx, async (tx) => {
		const [row] = await tx.select().from(letters).where(eq(letters.id, id));
		if (!row) throw notFound();
		const own = row.employeeId === m.access.employeeId;
		if (!own && !issuable(await resolveScope(tx, m.access, 'letter.issue'), m.access, row.employeeId)) throw notFound();
		await auditEvent(tx, ctx, 'letters', row.id, 'letter.download');
		return row;
	});
	return { fileName: l.fileName, contentType: 'application/pdf', body: await getObject(l.storageKey) };
}
