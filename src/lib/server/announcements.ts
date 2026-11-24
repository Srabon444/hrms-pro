import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ANNOUNCEMENT_AUDIENCES, announcements, branches, departments, employees } from './db/schema';
import type { AttachmentRules } from './attachments';
import { AppError } from './errors';
import { discardFiles, dropFiles, filesFor } from './file-store';
import { tenantToday } from './lifecycle';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

const optionalId = z
	.union([z.literal(''), z.uuid()])
	.transform((v) => v || null)
	.prefault('');
const announcementSchema = z
	.object({
		announcementId: optionalId,
		title: z.string().trim().min(1, 'Add a title.').max(160, 'Keep the title under 160 characters.'),
		body: z.string().trim().min(1, 'Write the announcement.').max(5000, 'Keep it under 5000 characters.'),
		audience: z.enum(ANNOUNCEMENT_AUDIENCES, 'Choose who sees it.'),
		departmentId: optionalId,
		branchId: optionalId,
		pinned: z.preprocess((v) => v === 'on' || v === true, z.boolean()),
		publishOn: z.iso.date('Enter the publish date.'),
		expiresOn: z
			.union([z.literal(''), z.iso.date('Enter a real end date.')])
			.transform((v) => v || null)
			.prefault('')
	})
	.refine((v) => v.audience !== 'department' || v.departmentId, { message: 'Choose the department.' })
	.refine((v) => v.audience !== 'branch' || v.branchId, { message: 'Choose the branch.' })
	.refine((v) => !v.expiresOn || v.expiresOn >= v.publishOn, {
		message: 'The end date cannot be before the publish date.'
	})
	.transform((v) => ({
		...v,
		departmentId: v.audience === 'department' ? v.departmentId : null,
		branchId: v.audience === 'branch' ? v.branchId : null
	}));

export const canRunAnnouncements = (access: Access) => scopesOf(access, 'announcement.manage').includes('all');
const onlyManagers = (access: Access) => {
	if (!canRunAnnouncements(access))
		throw new AppError('forbidden', 'Only people who manage announcements can do that.', 403);
};
const notFound = () => new AppError('not_found', 'That announcement does not exist.', 404);

export async function saveAnnouncement(m: Member, raw: Record<string, string>) {
	const { announcementId, ...input } = announcementSchema.parse(raw);
	onlyManagers(m.access);
	return withTenant(userCtx(m), async (tx) => {
		if (input.departmentId) {
			const [d] = await tx
				.select({ id: departments.id })
				.from(departments)
				.where(eq(departments.id, input.departmentId));
			if (!d) throw new AppError('invalid_department', 'Choose an existing department.', 400);
		}
		if (input.branchId) {
			const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
			if (!b) throw new AppError('invalid_branch', 'Choose an existing branch.', 400);
		}
		if (announcementId) {
			const [a] = await tx
				.update(announcements)
				.set(input)
				.where(eq(announcements.id, announcementId))
				.returning({ id: announcements.id });
			if (!a) throw notFound();
			return a.id;
		}
		const [a] = await tx
			.insert(announcements)
			.values({ tenantId: m.tenant.id, ...input, createdByUserId: m.user.userId })
			.returning({ id: announcements.id });
		return a.id;
	});
}

export async function deleteAnnouncement(m: Member, raw: Record<string, string>) {
	const id = z.uuid({ error: 'Choose an announcement.' }).parse(raw.announcementId);
	onlyManagers(m.access);
	const keys = await withTenant(userCtx(m), async (tx) => {
		const gone = await tx.delete(announcements).where(eq(announcements.id, id)).returning({ id: announcements.id });
		if (!gone.length) throw notFound();
		return dropFiles(tx, 'announcement', [id]);
	});
	await discardFiles(keys);
}

async function audienceOf(tx: Tx, employeeId: string | null) {
	if (!employeeId) return eq(announcements.audience, 'all');
	const ups = await tx.execute<{ id: string }>(sql`
		with recursive up(id, depth) as (
			select department_id, 0 from employees where id = ${employeeId}::uuid and department_id is not null
			union all
			select d.parent_id, u.depth + 1 from departments d join up u on d.id = u.id
			where d.parent_id is not null and u.depth < 20
		)
		select id from up`);
	const [me] = await tx.select({ branchId: employees.branchId }).from(employees).where(eq(employees.id, employeeId));
	const ids = ups.map((r) => r.id);
	return or(
		eq(announcements.audience, 'all'),
		ids.length ? inArray(announcements.departmentId, ids) : undefined,
		me?.branchId ? eq(announcements.branchId, me.branchId) : undefined
	)!;
}

const fields = {
	id: announcements.id,
	title: announcements.title,
	body: announcements.body,
	pinned: announcements.pinned,
	publishOn: announcements.publishOn,
	expiresOn: announcements.expiresOn,
	audience: announcements.audience,
	departmentId: announcements.departmentId,
	branchId: announcements.branchId,
	target: sql<string | null>`coalesce(${departments.name}, ${branches.name})`
};

async function liveFor(tx: Tx, access: Access) {
	const today = await tenantToday(tx);
	return and(
		lte(announcements.publishOn, today),
		or(isNull(announcements.expiresOn), gte(announcements.expiresOn, today)),
		await audienceOf(tx, access.employeeId)
	);
}

export async function announcementFeed(tx: Tx, access: Access, limit = 50) {
	const rows = await tx
		.select(fields)
		.from(announcements)
		.leftJoin(departments, eq(departments.id, announcements.departmentId))
		.leftJoin(branches, eq(branches.id, announcements.branchId))
		.where(await liveFor(tx, access))
		.orderBy(desc(announcements.pinned), desc(announcements.publishOn), desc(announcements.createdAt))
		.limit(limit);
	const attached = await filesFor(
		tx,
		'announcement',
		rows.map((r) => r.id)
	);
	return rows.map((r) => ({ ...r, files: attached.get(r.id) ?? [] }));
}

export const announcementAttachments: AttachmentRules = {
	async canRead(tx, access, id) {
		const live = canRunAnnouncements(access) ? undefined : await liveFor(tx, access);
		const found = await tx
			.select({ id: announcements.id })
			.from(announcements)
			.where(and(eq(announcements.id, id), live));
		return found.length > 0;
	},
	async canEdit(tx, access, id, lock) {
		if (!canRunAnnouncements(access)) return false;
		const q = tx.select({ id: announcements.id }).from(announcements).where(eq(announcements.id, id));
		return (lock ? await q.for('update') : await q).length > 0;
	}
};

export async function announcementAdmin(tx: Tx) {
	const today = await tenantToday(tx);
	const [rows, d, b] = await Promise.all([
		tx
			.select(fields)
			.from(announcements)
			.leftJoin(departments, eq(departments.id, announcements.departmentId))
			.leftJoin(branches, eq(branches.id, announcements.branchId))
			.orderBy(desc(announcements.publishOn), desc(announcements.createdAt))
			.limit(500),
		tx.select({ id: departments.id, name: departments.name }).from(departments).orderBy(departments.name),
		tx.select({ id: branches.id, name: branches.name }).from(branches).orderBy(branches.name)
	]);
	const state = (a: (typeof rows)[number]) =>
		a.publishOn > today ? 'scheduled' : a.expiresOn && a.expiresOn < today ? 'ended' : 'live';
	return {
		today,
		rows: rows.map((a) => ({ ...a, state: state(a) })),
		departments: d,
		branches: b
	};
}
