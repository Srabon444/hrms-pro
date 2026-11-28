import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	smallint,
	text,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { employees } from './org';
import { offers } from './recruitment';

export const SIGNATURE_STATUSES = ['draft', 'pending', 'completed', 'declined', 'cancelled'] as const;
export const SIGNER_STATUSES = ['waiting', 'signed', 'declined'] as const;
export const SIGN_METHODS = ['session', 'email_otp'] as const;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;

const inList = (column: unknown, values: readonly string[]) =>
	sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(','))})`;

export const signatureRequests = pgTable(
	'signature_requests',
	{
		...tenantBase(),
		title: text().notNull(),
		fileKey: text().notNull(),
		fileName: text().notNull(),
		fileSize: integer().notNull(),
		sha256: text().notNull(),
		status: text({ enum: SIGNATURE_STATUSES }).notNull().default('draft'),
		expiresAt: tstz().notNull(),
		offerId: uuid(),
		createdByUserId: uuid(),
		sentAt: tstz(),
		completedAt: tstz(),
		certificateKey: text(),
		certificateSha256: text(),
		declineReason: text()
	},
	(t) => [
		tenantKey('signature_requests', t),
		tfk('signature_requests_offer_fk', t, t.offerId, offers, 'cascade'),
		index('signature_requests_status_idx').on(t.tenantId, t.status),
		uniqueIndex('signature_requests_offer_live_uq')
			.on(t.tenantId, t.offerId)
			.where(sql`${t.offerId} is not null and ${t.status} in ('draft','pending','completed')`),
		check('signature_requests_title_ck', sql`length(trim(${t.title})) between 1 and 200`),
		check('signature_requests_file_name_ck', sql`length(${t.fileName}) between 1 and 200`),
		check('signature_requests_size_ck', sql`${t.fileSize} > 0`),
		check('signature_requests_sha_ck', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
		check('signature_requests_status_ck', inList(t.status, SIGNATURE_STATUSES)),
		check(
			'signature_requests_sent_ck',
			sql`${t.status} = 'cancelled' or (${t.status} = 'draft') = (${t.sentAt} is null)`
		),
		check(
			'signature_requests_completed_ck',
			sql`(${t.status} = 'completed') = (${t.completedAt} is not null and ${t.certificateKey} is not null and ${t.certificateSha256} ~ '^[0-9a-f]{64}$')`
		),
		check(
			'signature_requests_decline_ck',
			sql`${t.declineReason} is null or (${t.status} = 'declined' and length(${t.declineReason}) <= 500)`
		)
	]
);

export const signatureSigners = pgTable(
	'signature_signers',
	{
		...tenantBase(),
		requestId: uuid().notNull(),
		sortOrder: smallint().notNull(),
		employeeId: uuid(),
		candidate: boolean().notNull().default(false),
		name: text().notNull(),
		email: text().notNull(),
		status: text({ enum: SIGNER_STATUSES }).notNull().default('waiting'),
		tokenHash: text(),
		invitedAt: tstz(),
		signedAt: tstz(),
		declinedAt: tstz(),
		method: text({ enum: SIGN_METHODS }),
		ip: text(),
		userAgent: text(),
		typedName: text(),
		otpHash: text(),
		otpExpiresAt: tstz(),
		otpAttempts: smallint().notNull().default(0),
		otpSends: smallint().notNull().default(0)
	},
	(t) => [
		tenantKey('signature_signers', t),
		tfk('signature_signers_request_fk', t, t.requestId, signatureRequests, 'cascade'),
		tfk('signature_signers_employee_fk', t, t.employeeId, employees, 'restrict'),
		unique('signature_signers_order_uq').on(t.tenantId, t.requestId, t.sortOrder),
		uniqueIndex('signature_signers_email_uq').on(t.tenantId, t.requestId, sql`lower(${t.email})`),
		uniqueIndex('signature_signers_token_uq').on(t.tokenHash),
		check('signature_signers_candidate_ck', sql`not ${t.candidate} or ${t.employeeId} is null`),
		check('signature_signers_name_ck', sql`length(trim(${t.name})) between 1 and 200`),
		check('signature_signers_email_ck', sql`length(${t.email}) between 3 and 254`),
		check('signature_signers_status_ck', inList(t.status, SIGNER_STATUSES)),
		check('signature_signers_method_ck', sql`${t.method} is null or ${inList(t.method, SIGN_METHODS)}`),
		check(
			'signature_signers_signed_ck',
			sql`(${t.status} = 'signed') = (${t.signedAt} is not null and ${t.method} is not null and length(trim(coalesce(${t.typedName}, ''))) between 1 and 200)`
		),
		check('signature_signers_declined_ck', sql`(${t.status} = 'declined') = (${t.declinedAt} is not null)`),
		check(
			'signature_signers_method_kind_ck',
			sql`${t.method} is null or (${t.method} = 'session') = (${t.employeeId} is not null)`
		),
		check(
			'signature_signers_otp_attempts_ck',
			sql`${t.otpAttempts} between 0 and ${sql.raw(String(OTP_MAX_ATTEMPTS))}`
		),
		check('signature_signers_otp_sends_ck', sql`${t.otpSends} between 0 and ${sql.raw(String(OTP_MAX_SENDS))}`),
		check('signature_signers_ua_ck', sql`${t.userAgent} is null or length(${t.userAgent}) <= 500`),
		check('signature_signers_ip_ck', sql`${t.ip} is null or length(${t.ip}) <= 64`)
	]
);
