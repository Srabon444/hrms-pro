import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { API_REAUTH_MINUTES } from '#lib/server/api-keys.ts';
import { confirmRecentAuth } from '#lib/server/auth/service.ts';
import { recentlyAuthed } from '#lib/server/auth/session.ts';
import { WEBHOOK_EVENTS } from '#lib/server/db/schema/index.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import {
	createWebhook,
	deleteWebhook,
	listWebhooks,
	rotateWebhookSecret,
	setWebhookActive,
	WEBHOOK_MAX_ENDPOINTS
} from '#lib/server/webhooks.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'api.manage');
	return {
		...(await withTenant(userCtx(m), listWebhooks)),
		recent: await recentlyAuthed(m.user.sessionId, API_REAUTH_MINUTES),
		totp: m.user.totpEnabled,
		events: WEBHOOK_EVENTS,
		max: WEBHOOK_MAX_ENDPOINTS
	};
};

async function run<T>(fn: () => Promise<T>, requestId: string) {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message });
		return actionError(err, requestId);
	}
}

const events = (form: FormData) => form.getAll('events').map(String);

export const actions: Actions = {
	reauth: async ({ request, locals }) => {
		const m = requirePerm(locals, 'api.manage');
		const form = await request.formData();
		return run(async () => {
			await confirmRecentAuth(m.user, field(form, 'password'), field(form, 'code'));
			return { done: `Confirmed. You can add endpoints for the next ${API_REAUTH_MINUTES} minutes.` };
		}, locals.requestId);
	},
	create: async ({ request, locals, setHeaders }) => {
		const m = requirePerm(locals, 'api.manage');
		setHeaders({ 'cache-control': 'no-store' });
		const form = await request.formData();
		return run(
			async () => ({ secret: await createWebhook(m, { url: field(form, 'url'), events: events(form) }) }),
			locals.requestId
		);
	},
	rotate: async ({ request, locals, setHeaders }) => {
		const m = requirePerm(locals, 'api.manage');
		setHeaders({ 'cache-control': 'no-store' });
		const form = await request.formData();
		return run(async () => ({ secret: await rotateWebhookSecret(m, field(form, 'endpointId')) }), locals.requestId);
	},
	toggle: async ({ request, locals }) => {
		const m = requirePerm(locals, 'api.manage');
		const form = await request.formData();
		const on = field(form, 'active') === 'on';
		return run(async () => {
			await setWebhookActive(m, field(form, 'endpointId'), on);
			return { done: on ? 'Endpoint turned on.' : 'Endpoint turned off.' };
		}, locals.requestId);
	},
	remove: async ({ request, locals }) => {
		const m = requirePerm(locals, 'api.manage');
		const form = await request.formData();
		return run(async () => {
			await deleteWebhook(m, field(form, 'endpointId'));
			return { done: 'Endpoint deleted.' };
		}, locals.requestId);
	}
};
