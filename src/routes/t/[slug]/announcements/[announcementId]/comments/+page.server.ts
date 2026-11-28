import { error } from '@sveltejs/kit';
import {
	addComment,
	deleteComment,
	hideComment,
	threadPage,
	toggleReaction
} from '#lib/server/announcement-comments.ts';
import { AppError } from '#lib/server/errors.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { requireMember, userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

const member = (locals: App.Locals) => {
	const m = requireMember(locals);
	if (locals.membership?.status !== 'active') error(403, 'You do not have permission to do that.');
	return m;
};

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = member(locals);
	try {
		return await withTenant(userCtx(m), (tx) => threadPage(tx, m.access, params.announcementId));
	} catch (err) {
		if (err instanceof AppError && err.status === 404) error(404, err.message);
		throw err;
	}
};

type Step = (
	m: ReturnType<typeof member>,
	id: string,
	form: Record<string, string>,
	data: FormData
) => Promise<unknown>;

const run =
	(step: Step, done: string): Actions[string] =>
	async ({ request, locals, params }) => {
		const m = member(locals);
		const data = await request.formData();
		const form = formFields(data);
		try {
			await step(m, params.announcementId, form, data);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done };
	};

export const actions: Actions = {
	react: run((m, id, form) => toggleReaction(m, id, form.kind ?? ''), 'Reaction saved.'),
	comment: run(
		(m, id, form, data) => addComment(m, id, { body: form.body, mentions: data.getAll('mentions').map(String) }),
		'Comment posted.'
	),
	delete: run((m, id, form) => deleteComment(m, id, form.commentId ?? ''), 'Comment deleted.'),
	hide: run((m, id, form) => hideComment(m, id, form.commentId ?? '', true), 'Comment hidden.'),
	show: run((m, id, form) => hideComment(m, id, form.commentId ?? '', false), 'Comment shown again.')
};
