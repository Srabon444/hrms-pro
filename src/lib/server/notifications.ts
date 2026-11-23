import { and, eq, inArray, sql } from 'drizzle-orm';
import { config } from './config';
import { notificationPrefs, notifications } from './db/schema';
import { sendMail, type Mail } from './mail';
import type { Tx } from './tenancy';

export const NOTIFICATION_CATEGORIES = {
	access: 'Access and roles',
	approvals: 'Approvals'
} as const;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;

export type NewNotification = { category: NotificationCategory; title: string; body?: string; link?: string };

export async function notify(
	tx: Tx,
	tenantId: string,
	membershipIds: string[],
	n: NewNotification,
	tenantSlug: string
): Promise<Mail[]> {
	const ids = [...new Set(membershipIds)];
	if (!ids.length) return [];
	await tx.insert(notifications).values(ids.map((membershipId) => ({ tenantId, membershipId, ...n })));
	const optedOut = await tx
		.select({ id: notificationPrefs.membershipId })
		.from(notificationPrefs)
		.where(
			and(
				inArray(notificationPrefs.membershipId, ids),
				eq(notificationPrefs.category, n.category),
				eq(notificationPrefs.email, false)
			)
		);
	const skip = new Set(optedOut.map((r) => r.id));
	const recipients = ids.filter((id) => !skip.has(id));
	if (!recipients.length) return [];
	const rows = await tx.execute<{ email: string }>(
		sql`select email from tenant_users where membership_id in ${recipients} and membership_status = 'active'`
	);
	const link = n.link ? `\n\n${config().APP_URL}/t/${tenantSlug}/${n.link}` : '';
	return rows.map((r) => ({ to: r.email, subject: n.title, text: `${n.body ?? n.title}${link}` }));
}

export const sendAll = async (mails: Mail[]): Promise<void> => {
	await Promise.all(mails.map(sendMail));
};
