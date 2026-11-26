import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../../src/lib/server/auth/users';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { memberSecrets, memberships, tenantSettings } from '../../src/lib/server/db/schema';
import { processors } from '../../src/lib/server/jobs';
import type { Mail } from '../../src/lib/server/mail';
import { sendMail } from '../../src/lib/server/mail';
import { payRun } from '../../src/lib/server/payroll';
import { removePdfPassword, setPdfPassword, withPayslip } from '../../src/lib/server/payslip-mail';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { closeQueues, queue, startWorker } from '../../src/lib/server/queue';
import { loadAccess, userCtx } from '../../src/lib/server/rbac/access';
import { closeRedis } from '../../src/lib/server/redis';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { waitForMail } from '../mailpit';
import { createTenant, TEST_LOCALE } from './helpers';
import { hire, type Member } from './leak';

const ACCOUNT = 'account pass 4815162342';
const PDF_PW = 'payslip pass 2718281828';
const mailer = startWorker('mail', processors.mail);
const sql = () => ownerPool().sql;
let tenant: { id: string; slug: string };
const who: Record<string, Member & { email: string }> = {};
const emp: Record<string, string> = {};
const slip: Record<string, string> = {};

async function member(key: string, roles: string[], employeeId: string | null) {
	const email = `${key}-${randomUUID().slice(0, 8)}@pdf.test`;
	const userId = await createUser({ email, name: key, password: ACCOUNT });
	const id = await withTenant(systemCtx(tenant.id), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, userId, roles);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	who[key] = {
		email,
		user: { userId },
		tenant: { id: tenant.id, slug: tenant.slug, name: 'Pdf Co' },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member & { email: string };
}

async function approvedRun(period: string) {
	const [run] = await sql()<{ id: string }[]>`
		insert into payroll_runs (tenant_id, run_type, period, status, inputs_hash, output_hash, computed_by_user_id, computed_at)
		values (${tenant.id}, 'regular', ${period}, 'approved', '', '', ${who.boss.user.userId}, now()) returning id`;
	const rows = await sql()<{ id: string; employee_id: string }[]>`
		insert into payslips (tenant_id, run_id, employee_id, gross, net)
		select ${tenant.id}, ${run.id}, e, 5000000, 4500000 from unnest(${Object.values(emp)}::uuid[]) e
		returning id, employee_id`;
	const key = Object.fromEntries(Object.entries(emp).map(([k, v]) => [v, k]));
	for (const r of rows) slip[`${period}:${key[r.employee_id]}`] = r.id;
	return run.id;
}

const job = async (id: string) => (await queue('mail').getJob(`payslip-mail-${id}`))!.data as Mail;
const pdfText = (mail: Mail) => mail.inline![0].content.toString('latin1');
const code = (p: Promise<unknown>) =>
	p.then(
		() => 'ok',
		(e: { code?: string; issues?: { message: string }[] }) => e.code ?? e.issues?.[0].message
	);

beforeAll(async () => {
	tenant = await createTenant('pdf');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	emp.ana = await hire(tenant.id, 'Pdfana Rahman');
	emp.ben = await hire(tenant.id, 'Pdfben Okafor');
	emp.carl = await hire(tenant.id, 'Pdfcarl Lindqvist');
	await sql()`update employees set work_email = ${`carl-${randomUUID().slice(0, 8)}@pdf.test`} where id = ${emp.carl}`;
	await member('boss', ['owner'], null);
	await member('ana', [], emp.ana);
	await member('ben', [], emp.ben);
});

afterAll(async () => {
	await mailer.close();
	await closeQueues();
	await closeRedis();
	await closePools();
});

describe('payslip PDF password', () => {
	it('mirrors the form rules and refuses the sign-in password', async () => {
		expect(await code(setPdfPassword(who.ana, { password: 'short one', confirm: 'short one' }))).toBe(
			'Use at least 12 characters.'
		);
		expect(await code(setPdfPassword(who.ana, { password: 'x'.repeat(65), confirm: 'x'.repeat(65) }))).toBe(
			'Use at most 64 characters.'
		);
		expect(await code(setPdfPassword(who.ana, { password: PDF_PW, confirm: `${PDF_PW}!` }))).toBe(
			'The two passwords do not match.'
		);
		expect(await code(setPdfPassword(who.ana, { password: 'password1234', confirm: 'password1234' }))).toBe(
			'This password is too common.'
		);
		const unlockable = [
			'correct horse 😀 battery',
			'correct\thorse battery',
			'non\u00a0breaking space',
			' '.repeat(12)
		];
		expect(
			await Promise.all(unlockable.map((pw) => code(setPdfPassword(who.ana, { password: pw, confirm: pw }))))
		).toEqual(unlockable.map(() => 'Use letters, numbers, spaces and symbols only, no emoji.'));
		expect(await code(setPdfPassword(who.ana, { password: ACCOUNT, confirm: ACCOUNT }))).toBe('same_as_account');
		expect(await code(setPdfPassword(who.boss, { password: PDF_PW, confirm: PDF_PW }))).toBe('no_payslips');
		expect(await code(setPdfPassword(who.ana, { password: PDF_PW, confirm: PDF_PW }))).toBe('ok');
		const [row] = await sql()<{ enc: string }[]>`
			select pdf_password_enc as enc from member_secrets where membership_id = ${who.ana.access.membershipId}`;
		expect(row.enc).not.toContain(PDF_PW);
		const audited = await sql()`select 1 from audit_log where table_name = 'member_secrets'`;
		expect(audited).toHaveLength(0);
	});

	it('keeps each password readable and removable only by its owner', async () => {
		await setPdfPassword(who.ben, { password: PDF_PW, confirm: PDF_PW });
		const seen = await withTenant(userCtx(who.ben), async (tx) => ({
			rows: await tx.select({ id: memberSecrets.membershipId }).from(memberSecrets),
			deleted: await tx
				.delete(memberSecrets)
				.where(eq(memberSecrets.membershipId, who.ana.access.membershipId))
				.returning({ id: memberSecrets.id })
		}));
		expect(seen).toEqual({ rows: [{ id: who.ben.access.membershipId }], deleted: [] });
		expect(await withTenant(userCtx(who.boss), (tx) => tx.select().from(memberSecrets))).toEqual([]);
		await removePdfPassword(who.ben);
		const left = await sql()<
			{ id: string }[]
		>`select membership_id as id from member_secrets where tenant_id = ${tenant.id}`;
		expect(left).toEqual([{ id: who.ana.access.membershipId }]);
	});
});

describe('payslip email', () => {
	it('attaches a locked PDF for people with a password and a hint for the rest', async () => {
		await withTenant(systemCtx(tenant.id), (tx) => tx.update(tenantSettings).set({ payslipEmailPdf: true }));
		const runId = await approvedRun('2026-10');
		await payRun(who.boss, { runId });

		const ana = await job(slip['2026-10:ana']);
		expect(ana.payslip).toEqual({ payslipId: slip['2026-10:ana'], membershipId: who.ana.access.membershipId });
		expect(ana.inline).toBeUndefined();
		const ben = await job(slip['2026-10:ben']);
		expect(ben.payslip).toBeUndefined();
		expect(ben.text).toContain('set a payslip password on the Payslips page');
		const carl = await job(slip['2026-10:carl']);
		expect([carl.payslip, carl.text.includes('payslip password')]).toEqual([undefined, false]);

		const rendered = await withPayslip(ana);
		expect(rendered.payslip).toBeUndefined();
		expect(rendered.inline?.map((a) => [a.filename, a.contentType])).toEqual([
			['payslip-2026-10.pdf', 'application/pdf']
		]);
		expect(rendered.text).toContain('The payslip PDF is attached');
		const bytes = pdfText(rendered);
		expect(bytes.startsWith('%PDF-1.7')).toBe(true);
		expect(bytes).toMatch(/\/Encrypt \d+ 0 R/);
		expect(bytes).toMatch(/\/V 5\b/);
		expect(bytes).toMatch(/\/R 5\b/);
		expect(bytes).not.toContain('Pdfana');
		expect(bytes).not.toContain('Payslip 2026-10');

		const received = await waitForMail(who.ana.email);
		expect(received.attachments).toEqual(['payslip-2026-10.pdf']);
		expect(received.text).toContain('The payslip PDF is attached');
		expect((await waitForMail(who.ben.email)).attachments).toEqual([]);
	});

	it('sends a retried job once', async () => {
		const ana = await job(slip['2026-10:ana']);
		await sendMail(ana, `payslip-mail-${slip['2026-10:ana']}`);
		await new Promise((r) => setTimeout(r, 1500));
		const res = await fetch(
			`${process.env.MAILPIT_URL ?? 'http://localhost:58025'}/api/v1/search?query=${encodeURIComponent(`to:"${who.ana.email}"`)}`
		);
		expect(((await res.json()) as { messages: unknown[] }).messages).toHaveLength(1);
	});

	it('falls back to the link when the payslip, the password or the setting is gone', async () => {
		const ana = await job(slip['2026-10:ana']);
		const gone = await withPayslip({ ...ana, payslip: { ...ana.payslip!, payslipId: randomUUID() } });
		expect([gone.inline, gone.payslip]).toEqual([undefined, undefined]);
		expect(gone.text).not.toContain('attached');
		const other = await withPayslip({ ...ana, payslip: { ...ana.payslip!, payslipId: slip['2026-10:ben'] } });
		expect(other.inline).toBeUndefined();
		await withTenant(systemCtx(tenant.id), (tx) => tx.update(tenantSettings).set({ payslipEmailPdf: false }));
		expect((await withPayslip(ana)).inline).toBeUndefined();
		await withTenant(systemCtx(tenant.id), (tx) => tx.update(tenantSettings).set({ payslipEmailPdf: true }));
		await setPdfPassword(who.ben, { password: PDF_PW, confirm: PDF_PW });
		await sql()`update member_secrets set pdf_password_enc = (select pdf_password_enc from member_secrets where membership_id = ${who.ana.access.membershipId})
			where membership_id = ${who.ben.access.membershipId}`;
		const swapped = await withPayslip({
			...ana,
			payslip: { payslipId: slip['2026-10:ben'], membershipId: who.ben.access.membershipId }
		});
		expect([swapped.inline, swapped.text.includes('attached')]).toEqual([undefined, false]);
		await removePdfPassword(who.ben);
		await removePdfPassword(who.ana);
		expect(await sql()`select 1 from member_secrets where tenant_id = ${tenant.id}`).toHaveLength(0);
		expect((await withPayslip(ana)).inline).toBeUndefined();
	});

	it('sends the link only while the setting is off', async () => {
		await setPdfPassword(who.ana, { password: PDF_PW, confirm: PDF_PW });
		await withTenant(systemCtx(tenant.id), (tx) => tx.update(tenantSettings).set({ payslipEmailPdf: false }));
		const runId = await approvedRun('2026-09');
		await payRun(who.boss, { runId });
		const ana = await job(slip['2026-09:ana']);
		const ben = await job(slip['2026-09:ben']);
		expect(ana.payslip).toBeUndefined();
		expect(ben.text).not.toContain('payslip password');
	});
});
