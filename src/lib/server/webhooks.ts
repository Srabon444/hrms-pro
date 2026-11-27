import { createHmac, randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { API_REAUTH_MINUTES } from './api-keys';
import { auditEvent } from './audit';
import { decrypt, encrypt, randomToken } from './auth/crypto';
import { requireRecentAuth } from './auth/session';
import { now } from './clock';
import { authPool } from './db';
import { tenants, WEBHOOK_EVENTS, webhookDeliveries, webhookEndpoints, type WebhookEvent } from './db/schema';
import { AppError } from './errors';
import { log } from './log';
import type { Mail } from './mail';
import { notify, sendAll } from './notifications';
import { queue } from './queue';
import { can, userCtx, type requireMember } from './rbac/access';
import { checkUrl, safeFetch, type SafeResponse } from './safe-fetch';
import { afterCommit, systemCtx, withTenant, type Tx } from './tenancy';

export const WEBHOOK_MAX_ENDPOINTS = 10;
export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_DISABLE_AFTER = 50;
export const WEBHOOK_RETRY_SECONDS = [60, 300, 1800, 7200, 21600, 43200, 86400];
export const WEBHOOK_KEEP_DAYS = 30;
const LEASE_MS = 60_000;
const STALE_MS = 10 * 60_000;
const SWEEP_LIMIT = 1000;
const DAY = 86_400_000;

type Member = ReturnType<typeof requireMember>;
export type WebhookJob = { tenantId: string; deliveryId: string; attempt: number };
export type Sender = (
	url: string,
	init: { method: 'POST'; headers: Record<string, string>; body: string }
) => Promise<SafeResponse>;

const aad = (tenantId: string, endpointId: string) => `webhook:${tenantId}:${endpointId}`;
const newSecret = () => `whsec_${randomToken()}`;

export const signWebhook = (secret: string, ts: number, body: string) =>
	createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

async function enqueue(jobs: WebhookJob[], delay = 0): Promise<void> {
	if (!jobs.length) return;
	await queue('webhooks')
		.addBulk(
			jobs.map((j) => ({
				name: 'deliver',
				data: j,
				opts: {
					jobId: `wh-${j.deliveryId}-${j.attempt}`,
					delay,
					attempts: 1,
					removeOnComplete: true,
					removeOnFail: true
				}
			}))
		)
		.catch((err: Error) => log.warn({ err: err.message }, 'webhook queue failed'));
}

export async function emitWebhook(
	tx: Tx,
	tenantId: string,
	event: WebhookEvent,
	items: Record<string, string>[]
): Promise<void> {
	if (!items.length) return;
	const at = now().toISOString();
	const rows = await tx.execute<{ id: string }>(sql`
		insert into webhook_deliveries (tenant_id, endpoint_id, event, data, created_at, next_attempt_at)
		select ${tenantId}::uuid, e.id, ${event}::text, d.value, ${at}::timestamptz, ${at}::timestamptz
		from webhook_endpoints e cross join jsonb_array_elements(${JSON.stringify(items)}::jsonb) d
		where e.active and ${event}::text = any(e.events)
		returning id`);
	if (!rows.length) return;
	afterCommit(() => enqueue(rows.map((r) => ({ tenantId, deliveryId: r.id, attempt: 0 }))));
}

const reason = (err: unknown) => {
	if (err instanceof AppError) return err.message;
	const code = (err as NodeJS.ErrnoException).code ?? (err as Error).name;
	return `The endpoint could not be reached (${String(code).slice(0, 40)}).`;
};

async function holders(tx: Tx): Promise<string[]> {
	const rows = await tx.execute<{ id: string }>(sql`
		select distinct tu.membership_id as id from tenant_users tu
		join membership_roles mr on mr.membership_id = tu.membership_id
		join role_permissions rp on rp.role_id = mr.role_id
		where rp.permission = 'api.manage' and tu.membership_status = 'active'`);
	return rows.map((r) => r.id);
}

async function disableEndpoint(tx: Tx, tenantId: string, endpointId: string, url: string): Promise<Mail[]> {
	const [off] = await tx
		.update(webhookEndpoints)
		.set({ active: false, disabledAt: now() })
		.where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.active, true)))
		.returning({ id: webhookEndpoints.id });
	if (!off) return [];
	const [t] = await authPool().db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId));
	return notify(
		tx,
		tenantId,
		await holders(tx),
		{
			category: 'webhooks',
			title: 'A webhook endpoint was turned off',
			body: `The endpoint at ${new URL(url).host} failed ${WEBHOOK_DISABLE_AFTER} times in a row. Fix it, then turn it back on.`,
			link: 'settings/webhooks'
		},
		t?.slug ?? ''
	);
}

export async function deliverWebhook(job: WebhookJob, send: Sender = safeFetch): Promise<void> {
	const { tenantId, deliveryId, attempt } = job;
	const ctx = systemCtx(tenantId);
	const tries = attempt + 1;
	const claimed = await withTenant(ctx, async (tx) => {
		const [d] = await tx
			.update(webhookDeliveries)
			.set({ attempts: tries, nextAttemptAt: new Date(now().getTime() + LEASE_MS) })
			.where(
				and(
					eq(webhookDeliveries.id, deliveryId),
					eq(webhookDeliveries.status, 'pending'),
					eq(webhookDeliveries.attempts, attempt)
				)
			)
			.returning();
		if (!d) return null;
		const [e] = await tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, d.endpointId));
		if (!e?.active) {
			await tx
				.update(webhookDeliveries)
				.set({ status: 'failed', lastError: 'The endpoint is turned off.' })
				.where(eq(webhookDeliveries.id, d.id));
			return null;
		}
		let secret: string | null = null;
		try {
			secret = decrypt(e.secretEnc, undefined, aad(tenantId, e.id));
		} catch {
			log.error({ tenantId, endpointId: e.id }, 'webhook secret unreadable');
		}
		return { d, url: e.url, secret };
	});
	if (!claimed) return;
	const { d, url, secret } = claimed;
	const ts = Math.floor(now().getTime() / 1000);
	const body = JSON.stringify({ id: d.id, event: d.event, occurredAt: d.createdAt.toISOString(), data: d.data });
	let status: number | null = null;
	let error: string | null = secret === null ? 'The signing secret could not be read. Make a new secret.' : null;
	if (secret !== null)
		try {
			const res = await send(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'user-agent': 'HRMS-Pro-Webhooks/1',
					'x-hrms-event': d.event,
					'x-hrms-delivery': d.id,
					'x-hrms-signature': `t=${ts},v1=${signWebhook(secret, ts, body)}`
				},
				body
			});
			status = res.status;
			if (status < 200 || status > 299) error = `The endpoint answered ${status}.`;
		} catch (err) {
			error = reason(err);
		}
	const final = error === null ? 'delivered' : tries >= WEBHOOK_MAX_ATTEMPTS ? 'failed' : 'pending';
	const retryMs = (WEBHOOK_RETRY_SECONDS[tries - 1] ?? 0) * 1000;
	const mails = await withTenant(ctx, async (tx) => {
		const [row] = await tx
			.update(webhookDeliveries)
			.set({
				status: final,
				lastStatus: status,
				lastError: error,
				...(final === 'delivered' ? { deliveredAt: now() } : {}),
				...(final === 'pending' ? { nextAttemptAt: new Date(now().getTime() + retryMs) } : {})
			})
			.where(
				and(
					eq(webhookDeliveries.id, d.id),
					eq(webhookDeliveries.status, 'pending'),
					eq(webhookDeliveries.attempts, tries)
				)
			)
			.returning({ id: webhookDeliveries.id });
		if (!row) return [];
		if (final === 'delivered') {
			await tx
				.update(webhookEndpoints)
				.set({ failureCount: 0 })
				.where(and(eq(webhookEndpoints.id, d.endpointId), gt(webhookEndpoints.failureCount, 0)));
			return [];
		}
		if (final === 'pending') afterCommit(() => enqueue([{ tenantId, deliveryId: d.id, attempt: tries }], retryMs));
		const [e] = await tx
			.update(webhookEndpoints)
			.set({ failureCount: sql`${webhookEndpoints.failureCount} + 1` })
			.where(and(eq(webhookEndpoints.id, d.endpointId), eq(webhookEndpoints.active, true)))
			.returning({ failureCount: webhookEndpoints.failureCount });
		return e && e.failureCount >= WEBHOOK_DISABLE_AFTER ? disableEndpoint(tx, tenantId, d.endpointId, url) : [];
	});
	await sendAll(mails);
}

async function sweepFor(tenantId: string): Promise<void> {
	const t = now().getTime();
	const stale = await withTenant(systemCtx(tenantId), async (tx) => {
		await tx.delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, new Date(t - WEBHOOK_KEEP_DAYS * DAY)));
		return tx
			.select({ id: webhookDeliveries.id, attempts: webhookDeliveries.attempts })
			.from(webhookDeliveries)
			.where(and(eq(webhookDeliveries.status, 'pending'), lt(webhookDeliveries.nextAttemptAt, new Date(t - STALE_MS))))
			.orderBy(webhookDeliveries.nextAttemptAt)
			.limit(SWEEP_LIMIT);
	});
	await enqueue(stale.map((s) => ({ tenantId, deliveryId: s.id, attempt: s.attempts })));
}

export async function runWebhooks(): Promise<void> {
	const list = await authPool().db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
	await list.reduce<Promise<void>>(
		(prior, t) =>
			prior.then(() =>
				sweepFor(t.id).catch((err: Error) => log.error({ tenantId: t.id, err: err.message }, 'webhook sweep failed'))
			),
		Promise.resolve()
	);
}

const eventsSchema = z
	.array(z.enum(WEBHOOK_EVENTS, 'Pick events from the list.'))
	.min(1, 'Pick at least one event.')
	.transform((list) => [...new Set(list)]);

const idSchema = z.uuid('That endpoint does not exist.');

const manage = async (m: Member, stepUp: boolean) => {
	if (!can(m.access, 'api.manage')) throw new AppError('forbidden', 'You cannot manage webhooks.', 403);
	if (stepUp) await requireRecentAuth(m.user.sessionId, API_REAUTH_MINUTES);
};

const missing = () => new AppError('not_found', 'That endpoint does not exist.', 404);

export async function createWebhook(m: Member, input: { url: string; events: string[] }): Promise<string> {
	await manage(m, true);
	const url = checkUrl(input.url.trim()).href;
	const events = eventsSchema.parse(input.events);
	const id = randomUUID();
	const secret = newSecret();
	await withTenant(userCtx(m), async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext('webhooks'), hashtext(${m.tenant.id}))`);
		const [{ n }] = await tx.select({ n: count() }).from(webhookEndpoints);
		if (n >= WEBHOOK_MAX_ENDPOINTS)
			throw new AppError('limit', `You can have up to ${WEBHOOK_MAX_ENDPOINTS} endpoints.`, 409);
		await tx.insert(webhookEndpoints).values({
			id,
			tenantId: m.tenant.id,
			url,
			secretEnc: encrypt(secret, undefined, aad(m.tenant.id, id)),
			events,
			createdByMembershipId: m.access.membershipId
		});
		await auditEvent(tx, userCtx(m), 'webhook_endpoints', id, 'webhook.create', {
			host: new URL(url).host,
			events: events.join(',')
		});
	});
	return secret;
}

export async function rotateWebhookSecret(m: Member, rawId: string): Promise<string> {
	await manage(m, true);
	const id = idSchema.parse(rawId);
	const secret = newSecret();
	await withTenant(userCtx(m), async (tx) => {
		const [row] = await tx
			.update(webhookEndpoints)
			.set({ secretEnc: encrypt(secret, undefined, aad(m.tenant.id, id)) })
			.where(eq(webhookEndpoints.id, id))
			.returning({ id: webhookEndpoints.id });
		if (!row) throw missing();
		await auditEvent(tx, userCtx(m), 'webhook_endpoints', id, 'webhook.rotate');
	});
	return secret;
}

export async function setWebhookActive(m: Member, rawId: string, active: boolean): Promise<void> {
	await manage(m, false);
	const id = idSchema.parse(rawId);
	await withTenant(userCtx(m), async (tx) => {
		const [row] = await tx
			.update(webhookEndpoints)
			.set(active ? { active, failureCount: 0, disabledAt: null } : { active, disabledAt: now() })
			.where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.active, !active)))
			.returning({ id: webhookEndpoints.id });
		if (!row)
			throw new AppError('not_found', `That endpoint does not exist or is already ${active ? 'on' : 'off'}.`, 404);
	});
}

export async function deleteWebhook(m: Member, rawId: string): Promise<void> {
	await manage(m, false);
	const id = idSchema.parse(rawId);
	await withTenant(userCtx(m), async (tx) => {
		const [row] = await tx
			.delete(webhookEndpoints)
			.where(eq(webhookEndpoints.id, id))
			.returning({ id: webhookEndpoints.id, url: webhookEndpoints.url });
		if (!row) throw missing();
		await auditEvent(tx, userCtx(m), 'webhook_endpoints', id, 'webhook.delete', { host: new URL(row.url).host });
	});
}

export async function listWebhooks(tx: Tx) {
	const endpoints = await tx
		.select({
			id: webhookEndpoints.id,
			url: webhookEndpoints.url,
			events: webhookEndpoints.events,
			active: webhookEndpoints.active,
			failureCount: webhookEndpoints.failureCount,
			disabledAt: webhookEndpoints.disabledAt,
			createdAt: webhookEndpoints.createdAt
		})
		.from(webhookEndpoints)
		.orderBy(webhookEndpoints.createdAt);
	const deliveries = await tx
		.select({
			id: webhookDeliveries.id,
			endpointId: webhookDeliveries.endpointId,
			event: webhookDeliveries.event,
			status: webhookDeliveries.status,
			attempts: webhookDeliveries.attempts,
			lastStatus: webhookDeliveries.lastStatus,
			lastError: webhookDeliveries.lastError,
			createdAt: webhookDeliveries.createdAt
		})
		.from(webhookDeliveries)
		.orderBy(desc(webhookDeliveries.createdAt))
		.limit(25);
	return { endpoints, deliveries };
}
