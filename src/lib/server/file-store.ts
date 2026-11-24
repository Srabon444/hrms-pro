import { and, asc, eq, inArray } from 'drizzle-orm';
import { files, type AttachmentOwner } from './db/schema';
import { log } from './log';
import { deleteObject } from './storage';
import type { Tx } from './tenancy';

export async function discardFiles(stored: { key: string }[]) {
	await Promise.all(
		stored.map((s) => deleteObject(s.key).catch((err) => log.error({ err, key: s.key }, 'attachment cleanup failed')))
	);
}

export type FileItem = { id: string; filename: string; mime: string; size: number; createdAt: Date };

export async function filesFor(tx: Tx, type: AttachmentOwner, ownerIds: string[]) {
	const out = new Map<string, FileItem[]>();
	if (!ownerIds.length) return out;
	const rows = await tx
		.select({
			ownerId: files.ownerId,
			id: files.id,
			filename: files.filename,
			mime: files.mime,
			size: files.size,
			createdAt: files.createdAt
		})
		.from(files)
		.where(and(eq(files.ownerType, type), inArray(files.ownerId, ownerIds)))
		.orderBy(asc(files.createdAt), asc(files.id));
	for (const { ownerId, ...f } of rows) out.set(ownerId, [...(out.get(ownerId) ?? []), f]);
	return out;
}

export async function dropFiles(tx: Tx, type: AttachmentOwner, ownerIds: string[]) {
	if (!ownerIds.length) return [];
	return tx
		.delete(files)
		.where(and(eq(files.ownerType, type), inArray(files.ownerId, ownerIds)))
		.returning({ key: files.key });
}
