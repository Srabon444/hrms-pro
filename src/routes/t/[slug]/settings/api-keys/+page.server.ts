import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import {
	API_GRANTABLE,
	API_KEY_DAYS,
	API_REAUTH_MINUTES,
	createApiKey,
	listApiKeys,
	revokeApiKey
} from '#lib/server/api-keys.ts';
import { confirmRecentAuth } from '#lib/server/auth/service.ts';
import { recentlyAuthed } from '#lib/server/auth/session.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import { covers } from '#lib/rbac/grants.ts';
import { SCOPES } from '#lib/rbac/permissions.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'api.manage');
	return {
		keys: await withTenant(userCtx(m), listApiKeys),
		recent: await recentlyAuthed(m.user.sessionId, API_REAUTH_MINUTES),
		totp: m.user.totpEnabled,
		days: API_KEY_DAYS,
		grantable: API_GRANTABLE.map((p) => ({
			permission: p,
			scopes: SCOPES.filter((s) => covers(m.access.grants[p], s))
		}))
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

export const actions: Actions = {
	reauth: async ({ request, locals }) => {
		const m = requirePerm(locals, 'api.manage');
		const form = await request.formData();
		return run(async () => {
			await confirmRecentAuth(m.user, field(form, 'password'), field(form, 'code'));
			return { done: `Confirmed. You can make keys for the next ${API_REAUTH_MINUTES} minutes.` };
		}, locals.requestId);
	},
	create: async ({ request, locals, setHeaders }) => {
		const m = requirePerm(locals, 'api.manage');
		setHeaders({ 'cache-control': 'no-store' });
		const form = await request.formData();
		return run(async () => ({ key: await createApiKey(m, formFields(form)) }), locals.requestId);
	},
	revoke: async ({ request, locals }) => {
		const m = requirePerm(locals, 'api.manage');
		const form = await request.formData();
		return run(async () => {
			await revokeApiKey(userCtx(m), field(form, 'keyId'));
			return { done: 'Key revoked. Anything using it stops working now.' };
		}, locals.requestId);
	}
};
