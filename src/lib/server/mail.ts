import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config';
import { queue } from './queue';
import { getObject } from './storage';

export type Mail = {
	to: string;
	subject: string;
	text: string;
	attachments?: { filename: string; key: string; contentType: string }[];
	inline?: { filename: string; contentType: string; content: Buffer }[];
	tenantId?: string;
	payslip?: { payslipId: string; membershipId: string };
};

let transport: Transporter | undefined;

export async function deliverMail(mail: Mail): Promise<void> {
	transport ??= nodemailer.createTransport(config().SMTP_URL);
	const attachments = await Promise.all(
		(mail.attachments ?? []).map(async (a) => ({
			filename: a.filename,
			contentType: a.contentType,
			content: Buffer.from(await getObject(a.key))
		}))
	);
	const { to, subject, text } = mail;
	await transport.sendMail({
		from: config().MAIL_FROM,
		to,
		subject,
		text,
		attachments: [...attachments, ...(mail.inline ?? [])]
	});
}

export async function sendMail(mail: Mail, jobId?: string): Promise<void> {
	await queue('mail').add('send', mail, jobId ? { jobId } : undefined);
}
