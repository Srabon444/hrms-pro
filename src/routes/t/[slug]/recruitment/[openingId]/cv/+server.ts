import { assistJson, readCv, formOf } from '#lib/server/ai/assist.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const m = requirePerm(locals, 'recruitment.manage');
	return assistJson(async () => readCv(m, params.openingId, await formOf(request)));
};
