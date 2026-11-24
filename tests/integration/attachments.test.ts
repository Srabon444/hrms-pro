import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GrantMap } from '../../src/lib/rbac/grants';
import { addFiles, listFiles, openFile, removeFile, replaceFile } from '../../src/lib/server/attachments';
import { config } from '../../src/lib/server/config';
import { closePools } from '../../src/lib/server/db';
import { assets, files } from '../../src/lib/server/db/schema';
import type { requireMember } from '../../src/lib/server/rbac/access';
import { getObject, s3 } from '../../src/lib/server/storage';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let home: Tenant;
let away: Tenant;
let laptop: string;
let phone: string;
let manager: Member;
let reader: Member;
let stranger: Member;
let outsider: Member;

const pdf = (text = 'scan', name = 'scan.pdf') => new File([`%PDF-1.7 ${text}`], name, { type: 'application/pdf' });
const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], 'x.png');
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));

async function person(t: Tenant, grants: GrantMap): Promise<Member> {
	const u = await createUser();
	return {
		user: { userId: u.id },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: { membershipId: crypto.randomUUID(), employeeId: null, grants, roleKeys: [], isOwner: false }
	} as unknown as Member;
}

const newAsset = (t: Tenant, tag: string) =>
	withTenant(systemCtx(t.id), async (tx) => {
		const [a] = await tx
			.insert(assets)
			.values({ tenantId: t.id, tag, name: tag, category: 'Laptop', status: 'available' })
			.returning({ id: assets.id });
		return a.id;
	});

const listed = (m: Member, id: string) =>
	withTenant(systemCtx(m.tenant.id), (tx) => listFiles(tx, m.access, 'asset', id));

async function storedKeys(t: Tenant) {
	const res = await s3().send(
		new ListObjectsV2Command({ Bucket: config().S3_BUCKET, Prefix: `t/${t.id}/attachments/asset/` })
	);
	return (res.Contents ?? []).map((o) => o.Key!).sort();
}
const rowKeys = async (t: Tenant) =>
	(await withTenant(systemCtx(t.id), (tx) => tx.select({ key: files.key }).from(files))).map((r) => r.key).sort();

beforeAll(async () => {
	home = await createTenant('attach');
	away = await createTenant('attach2');
	laptop = await newAsset(home, 'LT-1');
	phone = await newAsset(home, 'PH-1');
	manager = await person(home, { 'asset.read': ['all'], 'asset.manage': ['all'] });
	reader = await person(home, { 'asset.read': ['all'] });
	stranger = await person(home, { 'asset.read': ['own'] });
	outsider = await person(away, { 'asset.read': ['all'], 'asset.manage': ['all'] });
});

afterAll(closePools);

describe('attachments', () => {
	it('stores files, lists them to readers and serves them with an audit entry', async () => {
		const [id] = await addFiles(manager, 'asset', laptop, [pdf('invoice', '../../invoice\u202E.pdf'), png()]);
		const seen = await listed(reader, laptop);
		expect(seen?.files.map((f) => f.filename).sort()).toEqual(['invoice.pdf', 'x.png']);
		expect(seen?.canEdit).toBe(false);
		expect((await listed(manager, laptop))?.canEdit).toBe(true);
		const file = await openFile(reader, id);
		expect(file.fileName).toBe('invoice.pdf');
		expect(new TextDecoder().decode(file.body)).toBe('%PDF-1.7 invoice');
		const [{ n }] = await withTenant(systemCtx(home.id), (tx) =>
			tx.execute<{ n: number }>(
				sql`select count(*)::int as n from audit_log where row_id = ${id} and event = 'file.download'`
			)
		);
		expect(n).toBe(1);
	});

	it('hides files from people outside the owner scope and from other tenants', async () => {
		const [id] = await addFiles(manager, 'asset', phone, [pdf()]);
		expect(await listed(stranger, phone)).toBeNull();
		expect(await code(openFile(stranger, id))).toBe('not_found');
		expect(await code(openFile(outsider, id))).toBe('not_found');
		expect(await code(removeFile(outsider, id))).toBe('not_found');
		expect(await code(addFiles(outsider, 'asset', phone, [pdf()]))).toBe('not_found');
		expect(await code(openFile(manager, 'nope'))).toBe('not_found');
	});

	it('lets only editors change files', async () => {
		const [id] = await addFiles(manager, 'asset', phone, [pdf()]);
		expect(await code(addFiles(reader, 'asset', phone, [pdf()]))).toBe('forbidden');
		expect(await code(removeFile(reader, id))).toBe('forbidden');
		expect(await code(replaceFile(reader, id, pdf()))).toBe('forbidden');
	});

	it('refuses wrong types, empty and oversized uploads', async () => {
		const docx = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])], 'a.docx');
		const fake = new File(['MZ not a pdf'], 'fake.pdf', { type: 'application/pdf' });
		const big = new File([new Uint8Array(6 * 1024 * 1024).fill(0x25)], 'big.pdf');
		expect(await code(addFiles(manager, 'asset', laptop, [docx]))).toBe('unsupported_file');
		expect(await code(addFiles(manager, 'asset', laptop, [fake]))).toBe('unsupported_file');
		expect(await code(addFiles(manager, 'asset', laptop, []))).toBe('no_file');
		expect(await code(addFiles(manager, 'asset', laptop, [new File([], 'e.pdf')]))).toBe('no_file');
		expect(await code(addFiles(manager, 'asset', laptop, [big, big]))).toBe('too_large');
	});

	it('caps files per owner even when two uploads race, leaving no orphan objects', async () => {
		const desk = await newAsset(home, 'DK-1');
		await addFiles(manager, 'asset', desk, [pdf()]);
		expect(await code(addFiles(manager, 'asset', desk, [pdf(), pdf(), pdf(), pdf(), pdf()]))).toBe('too_many');
		const results = await Promise.all([
			code(addFiles(manager, 'asset', desk, [pdf(), pdf(), pdf()])),
			code(addFiles(manager, 'asset', desk, [pdf(), pdf(), pdf()]))
		]);
		expect(results.sort()).toEqual(['ok', 'too_many']);
		expect((await listed(manager, desk))?.files).toHaveLength(4);
		expect(await storedKeys(home)).toEqual(await rowKeys(home));
	});

	it('replaces and removes a file together with its stored object', async () => {
		const chair = await newAsset(home, 'CH-1');
		const [id] = await addFiles(manager, 'asset', chair, [pdf('old')]);
		const [old] = await withTenant(systemCtx(home.id), (tx) => tx.select().from(files).where(eq(files.id, id)));
		const next = await replaceFile(manager, id, pdf('new', 'new.pdf'));
		expect(next).not.toBe(id);
		expect((await listed(manager, chair))?.files.map((f) => f.filename)).toEqual(['new.pdf']);
		await expect(getObject(old.key)).rejects.toThrow();
		expect(await code(openFile(manager, id))).toBe('not_found');
		await removeFile(manager, next);
		expect((await listed(manager, chair))?.files).toEqual([]);
		expect(await storedKeys(home)).toEqual(await rowKeys(home));
	});
});
