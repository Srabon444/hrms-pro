import { and, desc, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { auditEvent } from './audit';
import { DOCUMENT_CATEGORIES, employeeDocuments, employees, MAX_DOCUMENT_BYTES } from './db/schema';
import { AppError } from './errors';
import { log } from './log';
import type { Access } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { sniffType } from './sniff';
import { deleteObject, getObject, putObject } from './storage';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

const metaSchema = z.object({
	category: z.enum(DOCUMENT_CATEGORIES, { error: 'Choose a document type.' }),
	title: z.string().trim().min(1, 'Enter a title.').max(160),
	expiresOn: z.union([z.literal(''), z.iso.date('Enter a valid expiry date.')]).transform((v) => (v === '' ? null : v))
});

const notFound = () => new AppError('not_found', 'That document does not exist.', 404);

export async function assertManages(tx: Tx, access: Access, employeeId: string) {
	const [e] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, employeeId));
	if (!e || !inScope(await resolveScope(tx, access, 'employee.read'), employeeId))
		throw new AppError('not_found', 'That employee does not exist.', 404);
	if (!inScope(await resolveScope(tx, access, 'document.manage'), employeeId))
		throw new AppError('forbidden', 'You cannot manage documents for this person.', 403);
}

export async function uploadDocument(
	ctx: TenantCtx,
	access: Access,
	employeeId: string,
	raw: Record<string, string>,
	file: File | null
): Promise<string> {
	const target = z.uuid().safeParse(employeeId);
	if (!target.success) throw new AppError('not_found', 'That employee does not exist.', 404);
	const meta = metaSchema.parse(raw);
	if (!file || file.size === 0) throw new AppError('no_file', 'Choose a file to upload.', 400);
	if (file.size > MAX_DOCUMENT_BYTES) throw new AppError('too_large', 'Files can be at most 10 MB.', 413);
	const bytes = new Uint8Array(await file.arrayBuffer());
	const contentType = sniffType(bytes, file.name);
	if (!contentType) throw new AppError('unsupported_file', 'Upload a PDF, image, Word or Excel file.', 415);
	await withTenant(ctx, (tx) => assertManages(tx, access, target.data));
	const storageKey = `t/${ctx.tenantId}/documents/${randomUUID()}`;
	await putObject(storageKey, bytes, contentType);
	try {
		return await withTenant(ctx, async (tx) => {
			await assertManages(tx, access, target.data);
			const [row] = await tx
				.insert(employeeDocuments)
				.values({
					tenantId: ctx.tenantId,
					employeeId: target.data,
					...meta,
					fileName: file.name.slice(0, 200) || 'document',
					contentType,
					sizeBytes: bytes.byteLength,
					sha256: createHash('sha256').update(bytes).digest('hex'),
					storageKey,
					uploadedByUserId: ctx.userId ?? null
				})
				.returning({ id: employeeDocuments.id });
			return row.id;
		});
	} catch (err) {
		await deleteObject(storageKey).catch((e) => log.error({ err: e, storageKey }, 'orphan upload cleanup failed'));
		throw err;
	}
}

export async function listDocuments(tx: Tx, access: Access, employeeId: string) {
	const readable = inScope(await resolveScope(tx, access, 'document.read'), employeeId);
	if (!readable) return null;
	const rows = await tx
		.select({
			id: employeeDocuments.id,
			category: employeeDocuments.category,
			title: employeeDocuments.title,
			fileName: employeeDocuments.fileName,
			sizeBytes: employeeDocuments.sizeBytes,
			expiresOn: employeeDocuments.expiresOn,
			createdAt: employeeDocuments.createdAt
		})
		.from(employeeDocuments)
		.where(eq(employeeDocuments.employeeId, employeeId))
		.orderBy(desc(employeeDocuments.createdAt));
	return { rows, canManage: inScope(await resolveScope(tx, access, 'document.manage'), employeeId) };
}

async function findDocument(tx: Tx, access: Access, employeeId: string, documentId: string, lock: boolean) {
	if (!z.uuid().safeParse(documentId).success || !z.uuid().safeParse(employeeId).success) throw notFound();
	const q = tx
		.select()
		.from(employeeDocuments)
		.where(and(eq(employeeDocuments.id, documentId), eq(employeeDocuments.employeeId, employeeId)));
	const [doc] = lock ? await q.for('update') : await q;
	if (!doc || !inScope(await resolveScope(tx, access, 'document.read'), doc.employeeId)) throw notFound();
	return doc;
}

export async function openDocument(ctx: TenantCtx, access: Access, employeeId: string, documentId: string) {
	const doc = await withTenant(ctx, async (tx) => {
		const d = await findDocument(tx, access, employeeId, documentId, false);
		await auditEvent(tx, ctx, 'employee_documents', d.id, 'document.download');
		return d;
	});
	return { fileName: doc.fileName, contentType: doc.contentType, body: await getObject(doc.storageKey) };
}

export async function deleteDocument(ctx: TenantCtx, access: Access, employeeId: string, documentId: string) {
	const key = await withTenant(ctx, async (tx) => {
		const doc = await findDocument(tx, access, employeeId, documentId, true);
		if (!inScope(await resolveScope(tx, access, 'document.manage'), doc.employeeId))
			throw new AppError('forbidden', 'You cannot manage documents for this person.', 403);
		await tx.delete(employeeDocuments).where(eq(employeeDocuments.id, doc.id));
		return doc.storageKey;
	});
	await deleteObject(key).catch((err) => log.error({ err, key }, 'document object cleanup failed'));
}
