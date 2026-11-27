import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { decrypt, encrypt } from './auth/crypto';
import { isCommonPassword } from './auth/password';
import { matchesAccountPassword } from './auth/service';
import { authPool } from './db';
import { memberSecrets, payrollRuns, payslips, tenants } from './db/schema';
import { AppError } from './errors';
import { log } from './log';
import type { Mail } from './mail';
import { payslipAttachmentsSkipped } from './metrics';
import { canLockPdf } from './pdf';
import { payslipPdfInput } from './payroll';
import { renderPayslipPdf } from './payslip-pdf';
import { userCtx, type requireMember } from './rbac/access';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const PDF_PASSWORD_MIN = 12;
export const PDF_PASSWORD_MAX = 64;

const aad = (membershipId: string) => `pdfpw:${membershipId}`;

export const pdfPasswordSchema = z
	.object({
		password: z
			.string()
			.min(PDF_PASSWORD_MIN, `Use at least ${PDF_PASSWORD_MIN} characters.`)
			.max(PDF_PASSWORD_MAX, `Use at most ${PDF_PASSWORD_MAX} characters.`)
			.refine(
				(v) => v.trim() !== '' && !/[^\S ]/u.test(v) && canLockPdf(v),
				'Use letters, numbers, spaces and symbols only, no emoji.'
			)
			.refine((v) => !isCommonPassword(v), 'This password is too common.'),
		confirm: z.string()
	})
	.refine((v) => v.password === v.confirm, { message: 'The two passwords do not match.' });

export async function pdfPasswordSet(tx: Tx, membershipId: string): Promise<boolean> {
	const [row] = await tx
		.select({ id: memberSecrets.id })
		.from(memberSecrets)
		.where(and(eq(memberSecrets.membershipId, membershipId), isNotNull(memberSecrets.pdfPasswordEnc)));
	return !!row;
}

export async function setPdfPassword(m: Member, raw: Record<string, string>): Promise<void> {
	const { password } = pdfPasswordSchema.parse(raw);
	if (!m.access.employeeId) throw new AppError('no_payslips', 'Only people with payslips can set this password.', 400);
	if (await matchesAccountPassword(m.user.userId, password))
		throw new AppError('same_as_account', 'Pick a password that is different from your sign-in password.', 400);
	const enc = encrypt(password, undefined, aad(m.access.membershipId));
	await withTenant(userCtx(m), (tx) =>
		tx
			.insert(memberSecrets)
			.values({ tenantId: m.tenant.id, membershipId: m.access.membershipId, pdfPasswordEnc: enc })
			.onConflictDoUpdate({
				target: [memberSecrets.tenantId, memberSecrets.membershipId],
				set: { pdfPasswordEnc: enc }
			})
	);
}

export async function removePdfPassword(m: Member): Promise<void> {
	await withTenant(userCtx(m), (tx) => clearMemberSecret(tx, m.access.membershipId, 'pdfPasswordEnc'));
}

export async function clearMemberSecret(tx: Tx, membershipId: string, field: 'pdfPasswordEnc' | 'kioskPinMac') {
	const mine = eq(memberSecrets.membershipId, membershipId);
	const [row] = await tx
		.select({ pdfPasswordEnc: memberSecrets.pdfPasswordEnc, kioskPinMac: memberSecrets.kioskPinMac })
		.from(memberSecrets)
		.where(mine)
		.for('update');
	if (!row) return;
	const other = field === 'pdfPasswordEnc' ? row.kioskPinMac : row.pdfPasswordEnc;
	if (other === null) await tx.delete(memberSecrets).where(mine);
	else
		await tx
			.update(memberSecrets)
			.set({ [field]: null })
			.where(mine);
}

export type PayslipAttachment = { payslipId: string; membershipId: string };

async function lockedPayslip(tenantId: string, a: PayslipAttachment) {
	const [tenant] = await authPool().db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
	return withTenant({ ...systemCtx(tenantId), payrollAll: true }, async (tx) => {
		const [secret] = await tx
			.select({ enc: memberSecrets.pdfPasswordEnc, on: sql<boolean>`(select payslip_email_pdf from tenant_settings)` })
			.from(memberSecrets)
			.where(eq(memberSecrets.membershipId, a.membershipId));
		if (!secret?.enc) return { skipped: 'no_password' as const };
		if (!secret.on) return { skipped: 'setting_off' as const };
		const found = await payslipPdfInput(
			tx,
			a.payslipId,
			and(
				eq(payrollRuns.status, 'paid'),
				eq(
					payslips.employeeId,
					sql`(select employee_id from memberships where id = ${a.membershipId}::uuid and status = 'active')`
				)
			),
			tenant?.name ?? ''
		);
		if (!found) return { skipped: 'payslip_gone' as const };
		try {
			const password = decrypt(secret.enc, undefined, aad(a.membershipId));
			return { fileName: found.fileName, body: await renderPayslipPdf(found.pdf, password) };
		} catch {
			return { skipped: 'unreadable' as const };
		}
	});
}

export async function withPayslip(mail: Mail): Promise<Mail> {
	if (!mail.payslip || !mail.tenantId) return mail;
	const { payslip, ...rest } = mail;
	const locked = await lockedPayslip(mail.tenantId, payslip);
	if ('skipped' in locked) {
		payslipAttachmentsSkipped.inc({ reason: locked.skipped });
		log.warn(
			{ tenantId: mail.tenantId, payslipId: payslip.payslipId, reason: locked.skipped },
			'payslip sent without pdf'
		);
		return rest;
	}
	return {
		...rest,
		text: `${rest.text}\n\nThe payslip PDF is attached. Open it with the payslip password you set in the app.`,
		inline: [{ filename: locked.fileName, contentType: 'application/pdf', content: Buffer.from(locked.body) }]
	};
}
