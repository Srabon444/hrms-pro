import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { expenseCategories, expenseClaims, expenseItems, employees, memberships } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import {
	cancelClaim,
	decideClaim,
	expenseApprovals,
	expenseBoard,
	openReceipt,
	payClaim,
	saveCategory,
	submitClaim
} from '../../src/lib/server/expenses';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from '../../src/lib/server/config';
import { getObject, s3 } from '../../src/lib/server/storage';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const cat: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (fullName: string, managerId = '') =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		managerId,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01'
	});

async function member(key: string, roleKeys: string[], employeeId: string | null) {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const PDF = new TextEncoder().encode('%PDF-1.7 taxi');
const file = (bytes: Uint8Array, name: string) => new File([bytes as BlobPart], name);
const item = (i: number, categoryId: string, amount: string, spentOn = '2026-02-10', description = `Item ${i}`) => ({
	[`items.${i}.categoryId`]: categoryId,
	[`items.${i}.spentOn`]: spentOn,
	[`items.${i}.description`]: description,
	[`items.${i}.amount`]: amount
});
const claim = (key: string, form: Record<string, string>, files = new Map<number, File>()) =>
	submitClaim(who[key], { title: 'Client visit', ...form }, files);
const claimOf = async (id: string) =>
	(await withTenant(sys(), (tx) => tx.select().from(expenseClaims).where(eq(expenseClaims.id, id))))[0];
const itemsOf = (claimId: string) =>
	withTenant(sys(), (tx) => tx.select().from(expenseItems).where(eq(expenseItems.claimId, claimId)));
const decide = (key: string, claimId: string, decision = 'approve', payVia = 'direct') =>
	decideClaim(who[key], { claimId, decision, payVia, note: '' });

beforeAll(async () => {
	tenant = await createTenant('expenses');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.lea = await hire('Lea');
	ids.ana = await hire('Ana', ids.lea);
	ids.ben = await hire('Ben');
	ids.fin = await hire('Fin');
	await member('ana', ['employee'], ids.ana);
	await member('ben', ['employee'], ids.ben);
	await member('lea', ['line_manager', 'employee'], ids.lea);
	await member('fin', ['finance', 'employee'], ids.fin);
	await saveCategory(who.fin, '', { name: 'Travel', claimLimit: '1000', active: 'on' });
	await saveCategory(who.fin, '', { name: 'Meals', claimLimit: '', active: 'on' });
	await saveCategory(who.fin, '', { name: 'Old', claimLimit: '', active: '' });
	await withTenant(sys(), async (tx) => {
		for (const c of await tx.select().from(expenseCategories)) cat[c.name] = c.id;
	});
});

afterAll(closePools);

describe('categories', () => {
	it('stores limits in poisha, refuses duplicates and unknown ids, and edits in place', async () => {
		const rows = await withTenant(sys(), (tx) => tx.select().from(expenseCategories));
		expect(rows.find((r) => r.name === 'Travel')).toMatchObject({ claimLimit: 100000, active: true });
		expect(rows.find((r) => r.name === 'Meals')?.claimLimit).toBeNull();
		expect(rows.find((r) => r.name === 'Old')?.active).toBe(false);
		expect(await code(saveCategory(who.fin, '', { name: 'Travel', claimLimit: '', active: 'on' }))).toBe('duplicate');
		expect(
			await code(saveCategory(who.fin, crypto.randomUUID(), { name: 'Ghost', claimLimit: '', active: 'on' }))
		).toBe('not_found');
		expect(await code(saveCategory(who.fin, '', { name: 'Zero', claimLimit: '0', active: 'on' }))).toMatch(
			/more than zero/
		);
		await saveCategory(who.fin, cat.Meals, { name: 'Meals', claimLimit: '500.50', active: 'on' });
		const [meals] = await withTenant(sys(), (tx) =>
			tx.select().from(expenseCategories).where(eq(expenseCategories.id, cat.Meals))
		);
		expect(meals.claimLimit).toBe(50050);
		await saveCategory(who.fin, cat.Meals, { name: 'Meals', claimLimit: '', active: 'on' });
	});
});

describe('submitting', () => {
	it('stores items with receipts and totals the claim', async () => {
		const id = await claim(
			'ana',
			{ ...item(0, cat.Travel, '600'), ...item(2, cat.Meals, '120.50') },
			new Map([[0, file(PDF, 'taxi.pdf')]])
		);
		const c = await claimOf(id);
		expect(c).toMatchObject({ employeeId: ids.ana, status: 'submitted', total: 72050, title: 'Client visit' });
		const items = await itemsOf(id);
		expect(items.map((i) => i.amount).sort()).toEqual([12050, 60000]);
		const taxi = items.find((i) => i.amount === 60000)!;
		expect(taxi).toMatchObject({ receiptName: 'taxi.pdf', receiptType: 'application/pdf', receiptSize: PDF.length });
		expect(new TextDecoder().decode(await getObject(taxi.receiptKey!))).toBe('%PDF-1.7 taxi');
		expect(items.find((i) => i.amount === 12050)?.receiptKey).toBeNull();
	});

	it('refuses bad claims before storing anything', async () => {
		expect(await code(claim('ana', {}))).toBe('no_items');
		expect(
			await code(claim('ana', item(0, cat.Travel, '700')).then(() => claim('ana', item(0, cat.Travel, '0'))))
		).toMatch(/more than zero/);
		expect(await code(claim('ana', { ...item(0, cat.Travel, '600'), ...item(1, cat.Travel, '400.01') }))).toBe(
			'over_limit'
		);
		expect(await code(claim('ana', item(0, cat.Old, '10')))).toBe('bad_category');
		expect(await code(claim('ana', item(0, crypto.randomUUID(), '10')))).toBe('bad_category');
		expect(await code(claim('ana', item(0, cat.Meals, '10', '2099-01-01')))).toBe('future_expense');
		expect(await code(claim('ana', item(0, cat.Meals, '10.123')))).toMatch(/2 decimals/);
		expect(await code(claim('ana', { ...item(0, cat.Meals, '10'), title: '' }))).toMatch(/title/);
		expect(await code(claim('ana', { [`items.0.amount`]: '5' }))).toMatch(/category/);
		expect(
			await code(claim('ana', item(0, cat.Meals, '10'), new Map([[0, file(new Uint8Array([1, 2, 3]), 'x.exe')]])))
		).toBe('unsupported_file');
		const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
		expect(await code(claim('ana', item(0, cat.Meals, '10'), new Map([[0, file(zip, 'x.docx')]])))).toBe(
			'unsupported_file'
		);
		expect(await code(claim('ana', item(0, cat.Meals, '10'), new Map([[3, file(PDF, 'lost.pdf')]])))).toMatch(
			/category/
		);
		const big = new Uint8Array(6 * 1024 * 1024);
		big.set(PDF);
		expect(
			await code(
				claim(
					'ana',
					{ ...item(0, cat.Meals, '10'), ...item(1, cat.Meals, '10') },
					new Map([
						[0, file(big, 'a.pdf')],
						[1, file(big, 'b.pdf')]
					])
				)
			)
		).toBe('too_large');
		expect(await code(submitClaim(who.fin, { title: 'x', ...item(0, cat.Meals, '1') }, new Map()))).toBe('ok');
	});

	it('deletes receipts already stored when a later one is refused', async () => {
		const receipts = async () =>
			(await s3().send(new ListObjectsV2Command({ Bucket: config().S3_BUCKET, Prefix: `t/${tenant.id}/receipts/` })))
				.KeyCount;
		const before = await receipts();
		const files = new Map([
			[0, file(PDF, 'ok.pdf')],
			[1, file(new Uint8Array([1, 2, 3]), 'bad.exe')]
		]);
		expect(await code(claim('ana', { ...item(0, cat.Meals, '5'), ...item(1, cat.Meals, '5') }, files))).toBe(
			'unsupported_file'
		);
		expect(await receipts()).toBe(before);
	});

	it('refuses people who have left and members without an employee', async () => {
		await withTenant(sys(), (tx) =>
			tx.update(employees).set({ status: 'exited', exitDate: '2026-03-01' }).where(eq(employees.id, ids.ben))
		);
		expect(await code(claim('ben', item(0, cat.Meals, '10')))).toBe('exited');
		await withTenant(sys(), (tx) =>
			tx.update(employees).set({ status: 'active', exitDate: null }).where(eq(employees.id, ids.ben))
		);
		const nobody = { ...who.ana, access: { ...who.ana.access, employeeId: null } } as Member;
		expect(await code(submitClaim(nobody, { title: 'x', ...item(0, cat.Meals, '1') }, new Map()))).toBe('no_employee');
	});
});

describe('deciding and paying', () => {
	it('lets the manager approve team claims only, never their own', async () => {
		const ana = await claim('ana', item(0, cat.Meals, '50'));
		const ben = await claim('ben', item(0, cat.Meals, '60'));
		const lea = await claim('lea', item(0, cat.Meals, '70'));
		const inbox = await withTenant(sys(), (tx) => expenseApprovals(tx, who.lea.access));
		expect(inbox.map((i) => i.id)).toContain(ana);
		expect(inbox.map((i) => i.id)).not.toContain(ben);
		expect(inbox.map((i) => i.id)).not.toContain(lea);
		expect(inbox.find((i) => i.id === ana)?.title).toBe('Ana: Client visit · ৳50.00');
		expect(await code(decide('lea', ben))).toBe('not_found');
		expect(await code(decide('lea', lea))).toBe('own_claim');
		expect(await code(decide('ana', ana))).toBe('not_found');

		const mails = await decide('lea', ana, 'approve', 'payroll');
		expect(mails).toHaveLength(1);
		expect(mails[0].subject).toBe('Expense claim approved: Client visit');
		expect(mails[0].text).toContain('৳50.00 was approved. It will be paid with your salary.');
		expect(await claimOf(ana)).toMatchObject({
			status: 'approved',
			payVia: 'payroll',
			decidedByUserId: who.lea.user.userId
		});
		expect(await code(decide('lea', ana))).toBe('decided');
		expect(await code(payClaim(who.fin, { claimId: ana }))).toBe('not_payable');

		const rejected = await decideClaim(who.fin, {
			claimId: ben,
			decision: 'reject',
			payVia: 'direct',
			note: 'No bill'
		});
		expect(rejected[0].text).toContain('No bill');
		expect(await claimOf(ben)).toMatchObject({ status: 'rejected', payVia: null, decisionNote: 'No bill' });
	});

	it('pays direct claims once and tells the claimant', async () => {
		const id = await claim('ana', item(0, cat.Meals, '80'));
		expect(await code(payClaim(who.fin, { claimId: id }))).toBe('not_payable');
		await decide('fin', id, 'approve', 'direct');
		expect(await code(payClaim(who.lea, { claimId: id }))).toBe('not_found');
		const mails = await payClaim(who.fin, { claimId: id });
		expect(mails[0].text).toContain('৳80.00 was paid to you.');
		expect(await claimOf(id)).toMatchObject({ status: 'paid', paidByUserId: who.fin.user.userId });
		expect((await claimOf(id)).paidAt).toBeInstanceOf(Date);
		expect(await code(payClaim(who.fin, { claimId: id }))).toBe('not_payable');
	});

	it('never lets the payer mark their own claim paid', async () => {
		const own = await claim('fin', item(0, cat.Meals, '90'));
		await withTenant(sys(), (tx) =>
			tx.update(expenseClaims).set({ status: 'approved', payVia: 'direct' }).where(eq(expenseClaims.id, own))
		);
		expect(await code(payClaim(who.fin, { claimId: own }))).toBe('own_claim');
		const board = await withTenant(sys(), (tx) => expenseBoard(tx, who.fin));
		expect(board.toPay.map((c) => c.id)).not.toContain(own);
		expect(await claimOf(own)).toMatchObject({ status: 'approved', paidByUserId: null });
	});

	it('lets only the claimant cancel, and only while waiting', async () => {
		const id = await claim('ana', item(0, cat.Meals, '90'));
		expect(await code(cancelClaim(who.ben, { claimId: id }))).toBe('not_found');
		expect(await code(cancelClaim(who.ana, { claimId: id }))).toBe('ok');
		expect((await claimOf(id)).status).toBe('cancelled');
		expect(await code(cancelClaim(who.ana, { claimId: id }))).toBe('decided');
		expect(await code(decide('fin', id))).toBe('decided');
	});
});

describe('board and receipts', () => {
	it('shows each person the claims they may act on', async () => {
		const id = await claim('ana', item(0, cat.Meals, '33'));
		const board = (key: string) => withTenant(sys(), (tx) => expenseBoard(tx, who[key]));
		const ana = await board('ana');
		expect(ana.canSubmit).toBe(true);
		expect(ana.canManage).toBe(false);
		expect(ana.toApprove).toEqual([]);
		expect(ana.mine.find((c) => c.id === id)?.items[0]).toMatchObject({ category: 'Meals', amount: 3300 });
		const lea = await board('lea');
		expect(lea.toApprove.map((c) => c.id)).toContain(id);
		expect(lea.toApprove.every((c) => c.employeeId === ids.ana)).toBe(true);
		const payOnly = { ...who.fin, access: { ...who.fin.access, grants: { 'expense.pay': ['all'] } } } as Member;
		expect((await withTenant(sys(), (tx) => expenseBoard(tx, payOnly))).canSubmit).toBe(false);
		const fin = await board('fin');
		expect(fin.canManage).toBe(true);
		expect(fin.toApprove.some((c) => c.employeeId === ids.fin)).toBe(false);
		expect(fin.toPay.every((c) => c.status === 'approved' && c.payVia === 'direct')).toBe(true);
	});

	it('serves a receipt to the claimant and approvers only', async () => {
		const id = await claim('ana', item(0, cat.Meals, '44'), new Map([[0, file(PDF, 'lunch.pdf')]]));
		const [row] = await itemsOf(id);
		for (const key of ['ana', 'lea', 'fin']) {
			const r = await openReceipt(who[key], row.id);
			expect(r).toMatchObject({ fileName: 'lunch.pdf', contentType: 'application/pdf' });
			expect(new TextDecoder().decode(r.body)).toBe('%PDF-1.7 taxi');
		}
		expect(await code(openReceipt(who.ben, row.id))).toBe('not_found');
		const payer = {
			...who.ben,
			access: { ...who.ben.access, employeeId: null, grants: { 'expense.pay': ['all'] } }
		} as Member;
		expect((await openReceipt(payer, row.id)).fileName).toBe('lunch.pdf');
		expect(await code(openReceipt(who.ana, 'nope'))).toBe('not_found');
		const [plain] = await itemsOf(await claim('ana', item(0, cat.Meals, '1')));
		expect(await code(openReceipt(who.ana, plain.id))).toBe('not_found');
	});
});
