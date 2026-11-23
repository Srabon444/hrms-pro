import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GrantMap } from '../../src/lib/rbac/grants';
import { closePools } from '../../src/lib/server/db';
import { employeeDocuments, employees } from '../../src/lib/server/db/schema';
import { deleteDocument, listDocuments, openDocument, uploadDocument } from '../../src/lib/server/documents';
import { seedTenant } from '../../src/lib/server/platform/tenants';
import type { Access } from '../../src/lib/server/rbac/access';
import { getObject } from '../../src/lib/server/storage';
import { withTenant, type TenantCtx } from '../../src/lib/server/tenancy';
import { createTenant } from './helpers';

let ctx: TenantCtx;
let alice: string;
let bob: string;

const access = (employeeId: string | null, grants: GrantMap): Access => ({
	membershipId: crypto.randomUUID(),
	employeeId,
	grants,
	roleKeys: [],
	isOwner: false
});
const hr = access(null, { 'employee.read': ['all'], 'document.read': ['all'], 'document.manage': ['all'] });
const pdf = (text = 'hello') => new File([`%PDF-1.7 ${text}`], 'contract.pdf', { type: 'application/pdf' });
const meta = { category: 'contract', title: 'Offer letter', expiresOn: '' };
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));

beforeAll(async () => {
	const t = await createTenant('docs');
	await withTenant({ tenantId: t.id, actor: 'system' }, (tx) => seedTenant(tx, t.id));
	ctx = { tenantId: t.id, actor: 'user' };
	[alice, bob] = await withTenant(ctx, async (tx) => {
		const rows = await tx
			.insert(employees)
			.values(
				['Alice', 'Bob'].map((fullName, i) => ({
					tenantId: t.id,
					code: `D-${i}`,
					fullName,
					employmentType: 'full_time' as const,
					status: 'active' as const,
					joinDate: '2026-01-01'
				}))
			)
			.returning({ id: employees.id });
		return rows.map((r) => r.id);
	});
});

afterAll(closePools);

describe('employee documents', () => {
	it('stores the file with its hash and serves it back with an audit entry', async () => {
		const id = await uploadDocument(ctx, hr, alice, meta, pdf());
		const [row] = await withTenant(ctx, (tx) =>
			tx.select().from(employeeDocuments).where(eq(employeeDocuments.id, id))
		);
		expect(row.contentType).toBe('application/pdf');
		expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(new TextDecoder().decode(await getObject(row.storageKey))).toBe('%PDF-1.7 hello');
		const self = access(alice, { 'document.read': ['own'] });
		const file = await openDocument(ctx, self, alice, id);
		expect(file.fileName).toBe('contract.pdf');
		const audits = await withTenant(ctx, (tx) =>
			tx.execute<{ n: number }>(
				sql`select count(*)::int as n from audit_log where row_id = ${id} and event = 'document.download'`
			)
		);
		expect(audits[0].n).toBe(1);
	});

	it('hides other people documents and refuses wrong pairs of ids', async () => {
		const id = await uploadDocument(ctx, hr, alice, meta, pdf());
		const bobSelf = access(bob, { 'document.read': ['own'] });
		expect(await code(openDocument(ctx, bobSelf, alice, id))).toBe('not_found');
		expect(await code(openDocument(ctx, hr, bob, id))).toBe('not_found');
		expect(await code(openDocument(ctx, hr, alice, 'nope'))).toBe('not_found');
		expect(await withTenant(ctx, (tx) => listDocuments(tx, bobSelf, alice))).toBeNull();
		const mine = await withTenant(ctx, (tx) => listDocuments(tx, access(alice, { 'document.read': ['own'] }), alice));
		expect(mine!.canManage).toBe(false);
		expect(mine!.rows.length).toBeGreaterThan(0);
	});

	it('only accepts real allowed files within the size limit', async () => {
		const exe = new File(['MZ\x90\x00'], 'invoice.pdf', { type: 'application/pdf' });
		expect(await code(uploadDocument(ctx, hr, alice, meta, exe))).toBe('unsupported_file');
		expect(await code(uploadDocument(ctx, hr, alice, meta, new File([], 'a.pdf')))).toBe('no_file');
		const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf');
		expect(await code(uploadDocument(ctx, hr, alice, meta, big))).toBe('too_large');
		expect(await code(uploadDocument(ctx, hr, alice, { ...meta, category: 'secret' }, pdf()))).toBe('invalid');
		expect(await code(uploadDocument(ctx, hr, crypto.randomUUID(), meta, pdf()))).toBe('not_found');
	});

	it('lets only document managers in scope upload or delete, and removes the stored object', async () => {
		const self = access(alice, { 'employee.read': ['own'], 'document.read': ['own'] });
		expect(await code(uploadDocument(ctx, self, alice, meta, pdf()))).toBe('forbidden');
		const id = await uploadDocument(ctx, hr, alice, meta, pdf('bye'));
		expect(await code(deleteDocument(ctx, self, alice, id))).toBe('forbidden');
		const [row] = await withTenant(ctx, (tx) =>
			tx.select().from(employeeDocuments).where(eq(employeeDocuments.id, id))
		);
		await deleteDocument(ctx, hr, alice, id);
		await expect(getObject(row.storageKey)).rejects.toThrow();
		expect(await code(openDocument(ctx, hr, alice, id))).toBe('not_found');
	});
});
