import { assistJson, draftOpening, formOf } from '#lib/server/ai/assist.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const m = requirePerm(locals, 'recruitment.manage');
	return assistJson(async () => draftOpening(m, await formOf(request)));
};
