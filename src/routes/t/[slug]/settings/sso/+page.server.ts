import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { API_REAUTH_MINUTES } from '#lib/server/api-keys.ts';
import { confirmRecentAuth } from '#lib/server/auth/service.ts';
import { recentlyAuthed } from '#lib/server/auth/session.ts';
import { config } from '#lib/server/config.ts';
import { formFields } from '#lib/server/http/employee-form.ts';
import { actionError, field } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import {
	addSsoDomain,
	createScimToken,
	loadSso,
	removeSsoDomain,
	revokeScimToken,
	saveSsoConnection,
	setSsoState,
	verifySsoDomain
} from '#lib/server/sso.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requirePerm(locals, 'sso.manage');
	return {
		...(await withTenant(userCtx(m), loadSso)),
		scimUrl: new URL('/api/scim/v2', config().APP_URL).toString(),
		recent: await recentlyAuthed(m.user.sessionId, API_REAUTH_MINUTES),
		totp: m.user.totpEnabled
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
		const m = requirePerm(locals, 'sso.manage');
		const form = await request.formData();
		return run(async () => {
			await confirmRecentAuth(m.user, field(form, 'password'), field(form, 'code'));
			return { done: `Confirmed. You can change company sign-in for the next ${API_REAUTH_MINUTES} minutes.` };
		}, locals.requestId);
	},
	save: async ({ request, locals }) => {
		const m = requirePerm(locals, 'sso.manage');
		const form = await request.formData();
		return run(async () => {
			await saveSsoConnection(m, formFields(form));
			return { done: 'Connection saved.' };
		}, locals.requestId);
	},
	domain: async ({ request, locals }) => {
		const m = requirePerm(locals, 'sso.manage');
		const form = await request.formData();
		return run(async () => {
			await addSsoDomain(m, field(form, 'domain'));
			return { done: 'Domain added. Add the TXT record below, then check it.' };
		}, locals.requestId);
	},
	verify: async ({ request, locals }) => {
		const m = requirePerm(locals, 'sso.manage');
		const form = await request.formData();
		return run(
			async () => ({ done: `${await verifySsoDomain(m, field(form, 'domainId'))} is verified.` }),
			locals.requestId
		);
	},
	remove: async ({ request, locals }) => {
		const m = requirePerm(locals, 'sso.manage');
		const form = await request.formData();
		return run(async () => {
			await removeSsoDomain(m, field(form, 'domainId'));
			return { done: 'Domain removed.' };
		}, locals.requestId);
	},
	state: async ({ request, locals }) => {
		const m = requirePerm(locals, 'sso.manage');
		const form = await request.formData();
		const flag = (k: string) => (form.has(k) ? field(form, k) === 'on' : undefined);
		return run(async () => {
			await setSsoState(m, { active: flag('active'), enforce: flag('enforce') });
			return { done: 'Company sign-in updated.' };
		}, locals.requestId);
	},
	scim: async ({ locals }) => {
		const m = requirePerm(locals, 'sso.manage');
		return run(
			async () => ({
				scimToken: await createScimToken(m),
				done: 'Provisioning token created. Copy it now; it is not shown again.'
			}),
			locals.requestId
		);
	},
	scimRevoke: async ({ locals }) => {
		const m = requirePerm(locals, 'sso.manage');
		return run(async () => {
			await revokeScimToken(m);
			return { done: 'Provisioning token revoked.' };
		}, locals.requestId);
	}
};
