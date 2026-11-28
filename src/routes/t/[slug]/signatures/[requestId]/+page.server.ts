import { API_REAUTH_MINUTES } from '#lib/server/api-keys.ts';
import { confirmRecentAuth } from '#lib/server/auth/service.ts';
import { recentlyAuthed } from '#lib/server/auth/session.ts';
import {
	addSigner,
	cancelRequest,
	declineInternal,
	removeSigner,
	requestPage,
	resendInvite,
	sendRequest,
	signInternal
} from '#lib/server/esign.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { field } from '#lib/server/http/forms.ts';
import { requireModule } from '#lib/server/modules.ts';
import { sendAll } from '#lib/server/notifications.ts';
import { clientIp } from '#lib/server/work-sites.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = await requireModule(locals, 'esign');
	return {
		...(await requestPage(m, params.requestId)),
		recent: await recentlyAuthed(m.user.sessionId, API_REAUTH_MINUTES),
		totp: m.user.totpEnabled
	};
};

export const actions: Actions = {
	addSigner: async ({ request, locals, params }) => {
		const m = await requireModule(locals, 'esign', 'signature.manage');
		const form = formFields(await request.formData());
		try {
			await addSigner(m, { ...form, requestId: params.requestId });
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done: 'Signer added.' };
	},
	removeSigner: async ({ request, locals }) => {
		const m = await requireModule(locals, 'esign', 'signature.manage');
		try {
			await removeSigner(m, formFields(await request.formData()));
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		return { done: 'Signer removed.' };
	},
	send: async ({ locals, params }) => {
		const m = await requireModule(locals, 'esign', 'signature.manage');
		try {
			await sendAll(await sendRequest(m, { requestId: params.requestId }));
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		return { done: 'Sent. The first signer has been asked to sign.' };
	},
	resend: async ({ locals, params }) => {
		const m = await requireModule(locals, 'esign', 'signature.manage');
		try {
			await sendAll(await resendInvite(m, { requestId: params.requestId }));
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		return { done: 'The current signer has been asked again.' };
	},
	cancel: async ({ locals, params }) => {
		const m = await requireModule(locals, 'esign', 'signature.manage');
		try {
			await cancelRequest(m, { requestId: params.requestId });
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		return { done: 'Request cancelled.' };
	},
	reauth: async ({ request, locals }) => {
		const m = await requireModule(locals, 'esign');
		const form = await request.formData();
		try {
			await confirmRecentAuth(m.user, field(form, 'password'), field(form, 'code'));
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
		return { done: `Confirmed. You can sign for the next ${API_REAUTH_MINUTES} minutes.` };
	},
	sign: async ({ request, locals, params, getClientAddress }) => {
		const m = await requireModule(locals, 'esign');
		const form = formFields(await request.formData());
		try {
			await sendAll(
				await signInternal(
					m,
					{ ...form, requestId: params.requestId },
					{ ip: clientIp(getClientAddress()), userAgent: request.headers.get('user-agent') ?? '' }
				)
			);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done: 'Signed. Thank you.' };
	},
	decline: async ({ request, locals, params }) => {
		const m = await requireModule(locals, 'esign');
		const form = formFields(await request.formData());
		try {
			await sendAll(await declineInternal(m, { ...form, requestId: params.requestId }));
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done: 'You declined to sign. The sender has been told.' };
	}
};
