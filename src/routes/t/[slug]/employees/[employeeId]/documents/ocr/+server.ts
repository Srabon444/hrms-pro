import { assistJson, readDocument, formOf } from '#lib/server/ai/assist.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const m = requirePerm(locals, 'document.manage');
	return assistJson(async () => readDocument(m, params.employeeId, await formOf(request)));
};
