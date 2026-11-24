import { and, asc, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AttachmentRules } from './attachments';
import { employeeContacts, employeeEducation, employeeExperience, employees } from './db/schema';
import { blank, date, PROFILE_FIELDS } from './employees';
import { AppError } from './errors';
import { discardFiles, dropFiles } from './file-store';
import type { Access } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

export const MAX_LIST_ENTRIES = 20;

const required = (label: string, max: number) =>
	z.string().trim().min(1, `Enter the ${label}.`).max(max, `Keep it under ${max} characters.`);

const SELF_SCHEMA = z.object({
	phone: PROFILE_FIELDS.phone,
	personalEmail: PROFILE_FIELDS.personalEmail,
	presentAddress: PROFILE_FIELDS.presentAddress,
	permanentAddress: PROFILE_FIELDS.permanentAddress
});

const LISTS = {
	contact: {
		table: employeeContacts,
		schema: z.object({ name: required('name', 160), relation: required('relation', 60), phone: required('phone', 30) })
	},
	education: {
		table: employeeEducation,
		schema: z.object({
			degree: required('degree', 160),
			institution: required('institution', 160),
			passingYear: blank(z.coerce.number('Enter a valid year.').int().min(1950).max(2100))
		})
	},
	experience: {
		table: employeeExperience,
		schema: z
			.object({
				company: required('company', 160),
				title: required('job title', 160),
				startDate: z.iso.date('Enter a valid start date.'),
				endDate: date
			})
			.refine((v) => !v.endDate || v.endDate >= v.startDate, { message: 'The end date cannot be before the start.' })
	}
} as const;

export type ListKind = keyof typeof LISTS;
const kindSchema = z.enum(Object.keys(LISTS) as [ListKind, ...ListKind[]]);

type Rights = { self: boolean; manage: boolean };

async function rightsOver(tx: Tx, access: Access, employeeId: string, status: string): Promise<Rights> {
	const open = status !== 'exited';
	return {
		self: open && access.employeeId === employeeId,
		manage: open && inScope(await resolveScope(tx, access, 'employee.update'), employeeId)
	};
}

async function lockTarget(tx: Tx, access: Access, employeeId: string): Promise<Rights> {
	const target = z.uuid().safeParse(employeeId);
	const notFound = new AppError('not_found', 'That employee does not exist.', 404);
	if (!target.success) throw notFound;
	const [e] = await tx
		.select({ status: employees.status })
		.from(employees)
		.where(eq(employees.id, target.data))
		.for('update');
	if (!e || !inScope(await resolveScope(tx, access, 'employee.read'), target.data)) throw notFound;
	if (e.status === 'exited') throw new AppError('exited', 'This record is closed.', 409);
	return rightsOver(tx, access, target.data, e.status);
}

export async function profileLists(tx: Tx, access: Access, employeeId: string, status: string) {
	const [contacts, education, experience] = await Promise.all([
		tx
			.select()
			.from(employeeContacts)
			.where(eq(employeeContacts.employeeId, employeeId))
			.orderBy(asc(employeeContacts.createdAt)),
		tx
			.select()
			.from(employeeEducation)
			.where(eq(employeeEducation.employeeId, employeeId))
			.orderBy(desc(employeeEducation.passingYear), asc(employeeEducation.createdAt)),
		tx
			.select()
			.from(employeeExperience)
			.where(eq(employeeExperience.employeeId, employeeId))
			.orderBy(desc(employeeExperience.startDate))
	]);
	const rights = await rightsOver(tx, access, employeeId, status);
	return { contacts, education, experience, canEditSelf: rights.self, canEditLists: rights.self || rights.manage };
}

export async function updateOwnDetails(
	ctx: TenantCtx,
	access: Access,
	employeeId: string,
	form: Record<string, string>
) {
	const input = SELF_SCHEMA.parse(form);
	await withTenant(ctx, async (tx) => {
		const rights = await lockTarget(tx, access, employeeId);
		if (!rights.self) throw new AppError('forbidden', 'You can only change your own contact details here.', 403);
		await tx.update(employees).set(input).where(eq(employees.id, employeeId));
	});
}

export async function addListEntry(
	ctx: TenantCtx,
	access: Access,
	employeeId: string,
	kind: string,
	form: Record<string, string>
) {
	const list = LISTS[kindSchema.parse(kind)];
	const values = list.schema.parse(form);
	await withTenant(ctx, async (tx) => {
		const rights = await lockTarget(tx, access, employeeId);
		if (!rights.self && !rights.manage) throw new AppError('forbidden', 'You cannot edit this profile.', 403);
		const [{ n }] = await tx.select({ n: count() }).from(list.table).where(eq(list.table.employeeId, employeeId));
		if (n >= MAX_LIST_ENTRIES)
			throw new AppError('too_many', `A profile can hold at most ${MAX_LIST_ENTRIES} of these.`, 409);
		await tx.insert(list.table).values({ tenantId: ctx.tenantId, employeeId, ...values } as never);
	});
}

export async function removeListEntry(
	ctx: TenantCtx,
	access: Access,
	employeeId: string,
	kind: string,
	entryId: string
) {
	const listKind = kindSchema.parse(kind);
	const list = LISTS[listKind];
	const id = z.uuid().safeParse(entryId);
	const stored = await withTenant(ctx, async (tx) => {
		const rights = await lockTarget(tx, access, employeeId);
		if (!rights.self && !rights.manage) throw new AppError('forbidden', 'You cannot edit this profile.', 403);
		const gone = id.success
			? await tx
					.delete(list.table)
					.where(and(eq(list.table.id, id.data), eq(list.table.employeeId, employeeId)))
					.returning({ id: list.table.id })
			: [];
		if (!gone.length) throw new AppError('not_found', 'That entry does not exist.', 404);
		return listKind === 'contact' ? [] : dropFiles(tx, listKind, [gone[0].id]);
	});
	await discardFiles(stored);
}

const certificateRules = (kind: 'education' | 'experience'): AttachmentRules => {
	const owner = async (tx: Tx, id: string) => {
		const t = LISTS[kind].table;
		const [e] = await tx
			.select({ employeeId: t.employeeId, status: employees.status })
			.from(t)
			.innerJoin(employees, eq(employees.id, t.employeeId))
			.where(eq(t.id, id));
		return e;
	};
	return {
		async canRead(tx, access, id) {
			const e = await owner(tx, id);
			return (
				!!e &&
				(access.employeeId === e.employeeId || inScope(await resolveScope(tx, access, 'employee.read'), e.employeeId))
			);
		},
		async canEdit(tx, access, id) {
			const e = await owner(tx, id);
			if (!e) return false;
			const rights = await rightsOver(tx, access, e.employeeId, e.status);
			return rights.self || rights.manage;
		}
	};
};

export const educationAttachments = certificateRules('education');
export const experienceAttachments = certificateRules('experience');
