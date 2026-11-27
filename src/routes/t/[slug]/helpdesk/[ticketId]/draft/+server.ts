import { assistJson, draftReply } from '#lib/server/ai/assist.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params }) => {
	const m = requirePerm(locals, 'helpdesk.manage');
	return assistJson(async () => draftReply(m, params.ticketId));
};
