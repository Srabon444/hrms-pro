import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { changeRequests, employees, memberships, tenantSettings } from './db/schema';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { BANK_KEYS, bankChangeAlert, PROFILE_FIELDS, SENSITIVE_FIELDS } from './employees';
import { AppError } from './errors';
import { notify, sendAll } from './notifications';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';
import type { ApprovalItem } from './approvals';
import type { AttachmentRules } from './attachments';

type Member = ReturnType<typeof requireMember>;

const REQUESTABLE = {
	fullName: PROFILE_FIELDS.fullName,
	dateOfBirth: PROFILE_FIELDS.dateOfBirth,
	...SENSITIVE_FIELDS
};

export const CHANGE_LABELS: Record<keyof typeof REQUESTABLE, string> = {
	fullName: 'Full name',
	dateOfBirth: 'Date of birth',
	nationalId: 'National ID',
	passportNumber: 'Passport number',
	taxId: 'Tax ID',
	bankName: 'Bank name',
	bankAccountName: 'Bank account name',
	bankAccountNumber: 'Bank account number'
};

type Key = keyof typeof REQUESTABLE;
const KEYS = Object.keys(REQUESTABLE) as Key[];
const requestSchema = z.object(REQUESTABLE).partial();
const notFound = () => new AppError('not_found', 'That request does not exist.', 404);
const summarize = (changes: Record<string, unknown>) =>
	Object.keys(changes)
		.map((k) => CHANGE_LABELS[k as Key] ?? k)
		.join(', ');

export async function requestChange(m: Member, employeeId: string, form: Record<string, string>): Promise<string> {
	const filled = Object.fromEntries(KEYS.filter((k) => form[k]?.trim()).map((k) => [k, form[k]]));
	const wanted = requestSchema.parse(filled);
	if (!Object.keys(wanted).length) throw new AppError('no_change', 'Fill in at least one field to change.', 400);
	return withTenant(userCtx(m), async (tx) => {
		const target = z.uuid().safeParse(employeeId);
		const [current] = target.success
			? await tx.select().from(employees).where(eq(employees.id, target.data)).for('update')
			: [];
		if (!current || !inScope(await resolveScope(tx, m.access, 'employee.read'), current.id))
			throw new AppError('not_found', 'That employee does not exist.', 404);
		if (m.access.employeeId !== current.id)
			throw new AppError('forbidden', 'You can only request changes to your own record.', 403);
		if (current.status === 'exited') throw new AppError('exited', 'This record is closed.', 409);
		const changes = Object.fromEntries(
			(Object.entries(wanted) as [Key, string | null][]).filter(([k, v]) => current[k] !== v)
		);
		if (!Object.keys(changes).length) throw new AppError('no_change', 'Those details are already on your record.', 400);
		const [row] = await tx
			.insert(changeRequests)
			.values({ tenantId: m.tenant.id, employeeId: current.id, requestedByUserId: m.user.userId, changes })
			.returning({ id: changeRequests.id })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('request_pending', 'You already have a change waiting for HR.', 409);
				throw err;
			});
		return row.id;
	});
}

export async function cancelChange(m: Member, requestId: string) {
	const id = z.uuid().safeParse(requestId);
	if (!id.success) throw notFound();
	await withTenant(userCtx(m), async (tx) => {
		const gone = await tx
			.update(changeRequests)
			.set({ status: 'cancelled', decidedByUserId: m.user.userId, decidedAt: new Date() })
			.where(
				and(
					eq(changeRequests.id, id.data),
					eq(changeRequests.requestedByUserId, m.user.userId),
					eq(changeRequests.status, 'pending')
				)
			)
			.returning({ id: changeRequests.id });
		if (!gone.length) throw notFound();
	});
}

export async function ownPendingChange(tx: Tx, access: Access, employeeId: string) {
	if (access.employeeId !== employeeId) return null;
	const [row] = await tx
		.select({ id: changeRequests.id, changes: changeRequests.changes, at: changeRequests.createdAt })
		.from(changeRequests)
		.where(and(eq(changeRequests.employeeId, employeeId), eq(changeRequests.status, 'pending')));
	return row ? { ...row, summary: summarize(row.changes) } : null;
}

export async function changeApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	const scope = await resolveScope(tx, access, 'employee.sensitive.update');
	const rows = await tx
		.select({
			id: changeRequests.id,
			changes: changeRequests.changes,
			at: changeRequests.createdAt,
			name: employees.fullName
		})
		.from(changeRequests)
		.innerJoin(employees, eq(employees.id, changeRequests.employeeId))
		.where(and(eq(changeRequests.status, 'pending'), scopeWhere(scope, changeRequests.employeeId)))
		.orderBy(asc(changeRequests.createdAt))
		.limit(200);
	return rows.map((r) => ({
		id: r.id,
		kind: 'Profile change',
		title: `${r.name}: ${summarize(r.changes)}`,
		requestedBy: r.name,
		at: r.at,
		link: `approvals/changes/${r.id}`
	}));
}

async function loadForDecision(tx: Tx, access: Access, requestId: string) {
	const id = z.uuid().safeParse(requestId);
	if (!id.success) return null;
	const [row] = await tx
		.select({ request: changeRequests, employee: employees })
		.from(changeRequests)
		.innerJoin(employees, eq(employees.id, changeRequests.employeeId))
		.where(eq(changeRequests.id, id.data));
	if (!row || !inScope(await resolveScope(tx, access, 'employee.sensitive.update'), row.employee.id)) return null;
	return row;
}

export async function getChange(tx: Tx, access: Access, requestId: string) {
	const row = await loadForDecision(tx, access, requestId);
	if (!row) return null;
	const showCurrent = inScope(await resolveScope(tx, access, 'employee.sensitive.read'), row.employee.id);
	const { request, employee } = row;
	return {
		id: request.id,
		status: request.status,
		at: request.createdAt,
		decisionNote: request.decisionNote,
		employee: { id: employee.id, code: employee.code, fullName: employee.fullName },
		rows: (Object.entries(request.changes) as [Key, string | null][]).map(([k, v]) => ({
			key: k,
			label: CHANGE_LABELS[k] ?? k,
			current: showCurrent ? (employee[k] ?? '') : null,
			requested: v ?? ''
		}))
	};
}

const decisionSchema = z.object({
	decision: z.enum(['approve', 'reject']),
	note: z
		.string()
		.trim()
		.max(500, 'Keep the note under 500 characters.')
		.transform((v) => v || null)
});

export async function decideChange(m: Member, requestId: string, raw: Record<string, string>) {
	const { decision, note } = decisionSchema.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		const found = await loadForDecision(tx, m.access, requestId);
		if (!found) throw notFound();
		const [request] = await tx
			.select()
			.from(changeRequests)
			.where(eq(changeRequests.id, found.request.id))
			.for('update');
		if (request.status !== 'pending') throw new AppError('already_decided', 'This request was already handled.', 409);
		const [settings] = await tx.select({ single: tenantSettings.allowSingleAdminApproval }).from(tenantSettings);
		if (request.requestedByUserId === m.user.userId && !settings?.single)
			throw new AppError('self_approval', 'Someone else has to decide on your own request.', 403);
		const changes = requestSchema.parse(request.changes);
		if (decision === 'approve') {
			const [e] = await tx
				.select({ status: employees.status })
				.from(employees)
				.where(eq(employees.id, request.employeeId))
				.for('update');
			if (e.status === 'exited') throw new AppError('exited', 'This record is closed.', 409);
			await tx.update(employees).set(changes).where(eq(employees.id, request.employeeId));
		}
		await tx
			.update(changeRequests)
			.set({
				status: decision === 'approve' ? 'approved' : 'rejected',
				decidedByUserId: m.user.userId,
				decidedAt: new Date(),
				decisionNote: note
			})
			.where(eq(changeRequests.id, request.id));
		const owners = await tx
			.select({ id: memberships.id })
			.from(memberships)
			.where(eq(memberships.employeeId, request.employeeId));
		const outcome = await notify(
			tx,
			m.tenant.id,
			owners.map((o) => o.id),
			{
				category: 'profile',
				title: decision === 'approve' ? 'Your profile change was approved' : 'Your profile change was declined',
				body: note ?? undefined,
				link: `employees/${request.employeeId}`
			},
			m.tenant.slug
		);
		const bank = decision === 'approve' && BANK_KEYS.some((k) => k in changes);
		return bank
			? [...outcome, ...(await bankChangeAlert(tx, m.tenant.id, request.employeeId, m.tenant.slug))]
			: outcome;
	});
	await sendAll(mails);
}

export const changeAttachments: AttachmentRules = {
	async canRead(tx, access, id) {
		const [r] = await tx
			.select({ employeeId: changeRequests.employeeId })
			.from(changeRequests)
			.where(eq(changeRequests.id, id));
		if (!r) return false;
		return (
			r.employeeId === access.employeeId ||
			inScope(await resolveScope(tx, access, 'employee.sensitive.update'), r.employeeId)
		);
	},
	async canEdit(tx, access, id, lock) {
		const q = tx
			.select({ employeeId: changeRequests.employeeId, status: changeRequests.status })
			.from(changeRequests)
			.where(eq(changeRequests.id, id));
		const [r] = lock ? await q.for('update') : await q;
		return !!r && r.status === 'pending' && r.employeeId === access.employeeId;
	}
};
