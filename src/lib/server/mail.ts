import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config';
import { queue } from './queue';

export type Mail = { to: string; subject: string; text: string };

let transport: Transporter | undefined;

export async function deliverMail(mail: Mail): Promise<void> {
	transport ??= nodemailer.createTransport(config().SMTP_URL);
	await transport.sendMail({ from: config().MAIL_FROM, ...mail });
}

export async function sendMail(mail: Mail): Promise<void> {
	await queue('mail').add('send', mail);
}
