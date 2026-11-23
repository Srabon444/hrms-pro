import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomToken, sha256 } from './auth/crypto';
import { now } from './clock';
import { config } from './config';
import { invitations, roles } from './db/schema';
import { AppError } from './errors';
import type { Mail } from './mail';
import type { Tx } from './tenancy';

const INVITE_TTL_MS = 7 * 24 * 3600_000;

export type InvitationInput = {
	tenantId: string;
	email: string;
	roleIds: string[];
	invitedByMembershipId?: string | null;
	employeeId?: string | null;
};

export async function createInvitation(tx: Tx, input: InvitationInput): Promise<string> {
	const email = input.email.trim().toLowerCase();
	const roleIds = [...new Set(input.roleIds)];
	if (roleIds.length) {
		const found = await tx.select({ id: roles.id }).from(roles).where(inArray(roles.id, roleIds));
		if (found.length !== roleIds.length) throw new AppError('role_not_found', 'One or more roles do not exist');
	}
	await tx
		.update(invitations)
		.set({ revokedAt: now() })
		.where(and(eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
	const token = randomToken();
	await tx.insert(invitations).values({
		tenantId: input.tenantId,
		email,
		tokenHash: sha256(token),
		roleIds,
		employeeId: input.employeeId ?? null,
		invitedByMembershipId: input.invitedByMembershipId ?? null,
		expiresAt: new Date(now().getTime() + INVITE_TTL_MS)
	});
	return token;
}

export const inviteLink = (token: string): string => `${config().APP_URL}/invite/${token}`;

export const invitationMail = (to: string, tenantName: string, token: string): Mail => ({
	to,
	subject: `You are invited to ${tenantName} on HRMS`,
	text: `You have been invited to join ${tenantName}.\n\nAccept the invitation within 7 days:\n${inviteLink(token)}\n\nIf you did not expect this, ignore this email.`
});
