import { askHr } from '#lib/server/ai/ask.ts';
import { assistJson, formOf } from '#lib/server/ai/assist.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const m = requirePerm(locals, 'ai.use');
	return assistJson(async () => askHr(m, await formOf(request)));
};
