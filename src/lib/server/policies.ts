import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { activeMembershipsOf } from './approval-chain';
import { auditEvent } from './audit';
import { employees, fileTexts, MAX_DOCUMENT_BYTES, policies, policyAcknowledgements } from './db/schema';
import { queueFileText } from './file-text';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { log } from './log';
import type { Mail } from './mail';
import { notify } from './notifications';
import { scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { sniffType } from './sniff';
import { deleteObject, getObject, putObject } from './storage';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

const checkbox = z.preprocess((v) => v === 'on' || v === true, z.boolean());
const policySchema = z.object({
	policyId: z
		.union([z.literal(''), z.uuid()])
		.transform((v) => v || null)
		.prefault(''),
	title: z.string().trim().min(1, 'Name the policy.').max(160, 'Keep the title under 160 characters.'),
	description: z.string().trim().max(2000, 'Keep the summary under 2000 characters.').prefault(''),
	requiresAck: checkbox,
	active: checkbox
});
const ackSchema = z.object({
	policyId: z.uuid({ error: 'Choose a policy.' }),
	version: z.coerce.number('Choose a policy version.').int('Choose a policy version.')
});

export const canRunPolicies = (access: Access) => scopesOf(access, 'policy.manage').includes('all');
const notFound = () => new AppError('not_found', 'That policy does not exist.', 404);

async function readPdf(file: File | null) {
	if (!file || file.size === 0) return null;
	if (file.size > MAX_DOCUMENT_BYTES) throw new AppError('too_large', 'Files can be at most 10 MB.', 413);
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (sniffType(bytes, file.name) !== 'application/pdf')
		throw new AppError('unsupported_file', 'Upload the policy as a PDF.', 415);
	return {
		bytes,
		meta: {
			fileName: file.name.slice(0, 200) || 'policy.pdf',
			contentType: 'application/pdf',
			sizeBytes: bytes.byteLength,
			sha256: createHash('sha256').update(bytes).digest('hex')
		}
	};
}

async function askEveryone(tx: Tx, m: Member, title: string, version: number) {
	const staff = await tx.select({ id: employees.id }).from(employees).where(ne(employees.status, 'exited'));
	const ids = (
		await activeMembershipsOf(
			tx,
			staff.map((e) => e.id)
		)
	).filter((id) => id !== m.access.membershipId);
	return notify(
		tx,
		m.tenant.id,
		ids,
		{
			category: 'policies',
			title: version > 1 ? `${title} was updated. Please read it again.` : `Please read ${title}`,
			link: 'policies'
		},
		m.tenant.slug
	);
}

export async function savePolicy(
	m: Member,
	raw: Record<string, string>,
	file: File | null
): Promise<{ id: string; mails: Mail[] }> {
	const { policyId, ...input } = policySchema.parse(raw);
	if (!canRunPolicies(m.access)) throw new AppError('forbidden', 'Only people who manage policies can do that.', 403);
	const upload = await readPdf(file);
	if (!policyId && !upload) throw new AppError('no_file', 'Choose the policy file.', 400);
	const stored = upload && { ...upload.meta, storageKey: `t/${m.tenant.id}/policies/${randomUUID()}` };
	if (upload && stored) await putObject(stored.storageKey, upload.bytes, stored.contentType);
	try {
		const saved = await withTenant(userCtx(m), async (tx) => {
			const clash = (err: unknown) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('title_exists', 'Another policy already uses that title.', 409);
				throw err;
			};
			const today = await tenantToday(tx);
			if (!policyId) {
				const [p] = await tx
					.insert(policies)
					.values({
						tenantId: m.tenant.id,
						...input,
						...stored!,
						publishedOn: today,
						createdByUserId: m.user.userId
					})
					.returning({ id: policies.id, title: policies.title })
					.catch(clash);
				const mails = input.active && input.requiresAck ? await askEveryone(tx, m, p.title, 1) : [];
				return { id: p.id, mails };
			}
			const [current] = await tx.select().from(policies).where(eq(policies.id, policyId)).for('update');
			if (!current) throw notFound();
			const version = stored ? current.version + 1 : current.version;
			if (stored) await tx.delete(fileTexts).where(eq(fileTexts.policyId, current.id));
			await tx
				.update(policies)
				.set({ ...input, ...(stored ? { ...stored, publishedOn: today } : {}), version })
				.where(eq(policies.id, current.id))
				.catch(clash);
			const wake = input.active && input.requiresAck && (!!stored || !current.active || !current.requiresAck);
			const mails = wake ? await askEveryone(tx, m, input.title, version) : [];
			return { id: current.id, mails };
		});
		if (stored) await queueFileText({ tenantId: m.tenant.id, policyId: saved.id, sha256: stored.sha256 });
		return saved;
	} catch (err) {
		if (stored)
			await deleteObject(stored.storageKey).catch((e) =>
				log.error({ err: e, storageKey: stored.storageKey }, 'orphan upload cleanup failed')
			);
		throw err;
	}
}

export async function acknowledgePolicy(m: Member, raw: Record<string, string>) {
	const input = ackSchema.parse(raw);
	const me = m.access.employeeId;
	if (!me) throw new AppError('no_employee', 'Your account is not linked to an employee record.', 400);
	await withTenant(userCtx(m), async (tx) => {
		const [p] = await tx
			.select()
			.from(policies)
			.where(and(eq(policies.id, input.policyId), eq(policies.active, true)));
		if (!p) throw notFound();
		if (!p.requiresAck) throw new AppError('no_ack', 'This policy does not need an acknowledgement.', 400);
		if (p.version !== input.version)
			throw new AppError('stale_version', 'The policy changed while you were reading. Open it again.', 409);
		await tx
			.insert(policyAcknowledgements)
			.values({ tenantId: m.tenant.id, policyId: p.id, employeeId: me, version: p.version, sha256: p.sha256 })
			.onConflictDoNothing();
	});
}

export async function policyList(tx: Tx, access: Access) {
	const manager = canRunPolicies(access);
	const me = access.employeeId;
	const rows = await tx
		.select({
			id: policies.id,
			title: policies.title,
			description: policies.description,
			version: policies.version,
			requiresAck: policies.requiresAck,
			active: policies.active,
			publishedOn: policies.publishedOn,
			acknowledgedAt: me
				? sql<Date | null>`(select pa.acknowledged_at from policy_acknowledgements pa where pa.policy_id = policies.id and pa.version = policies.version and pa.employee_id = ${me}::uuid)`
				: sql<Date | null>`null::timestamptz`,
			acked: sql<number>`(select count(*)::int from policy_acknowledgements pa join employees e on e.id = pa.employee_id where pa.policy_id = policies.id and pa.version = policies.version and e.status <> 'exited')`
		})
		.from(policies)
		.where(manager ? undefined : eq(policies.active, true))
		.orderBy(desc(policies.active), asc(policies.title));
	const [{ staff }] = manager
		? await tx
				.select({ staff: sql<number>`count(*)::int` })
				.from(employees)
				.where(ne(employees.status, 'exited'))
		: [{ staff: 0 }];
	return { rows: rows.map((r) => (manager ? r : { ...r, acked: 0 })), staff, manager, canAck: !!me };
}

export async function policyReport(tx: Tx, access: Access, id: string) {
	if (!canRunPolicies(access) || !z.uuid().safeParse(id).success) return null;
	const [policy] = await tx.select().from(policies).where(eq(policies.id, id));
	if (!policy) return null;
	const people = await tx
		.select({
			id: employees.id,
			name: employees.fullName,
			code: employees.code,
			acknowledgedAt: policyAcknowledgements.acknowledgedAt
		})
		.from(employees)
		.leftJoin(
			policyAcknowledgements,
			and(
				eq(policyAcknowledgements.employeeId, employees.id),
				eq(policyAcknowledgements.policyId, policy.id),
				eq(policyAcknowledgements.version, policy.version)
			)
		)
		.where(ne(employees.status, 'exited'))
		.orderBy(sql`${policyAcknowledgements.acknowledgedAt} is not null`, asc(employees.fullName));
	return { policy, people };
}

export async function openPolicy(m: Member, id: string) {
	if (!z.uuid().safeParse(id).success) throw notFound();
	const ctx = userCtx(m);
	const p = await withTenant(ctx, async (tx) => {
		const [row] = await tx
			.select()
			.from(policies)
			.where(and(eq(policies.id, id), canRunPolicies(m.access) ? undefined : eq(policies.active, true)));
		if (!row) throw notFound();
		await auditEvent(tx, ctx, 'policies', row.id, 'policy.download');
		return row;
	});
	return { fileName: p.fileName, contentType: p.contentType, body: await getObject(p.storageKey) };
}
