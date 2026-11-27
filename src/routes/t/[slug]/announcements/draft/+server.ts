import { assistJson, draftAnnouncement, formOf } from '#lib/server/ai/assist.ts';
import { requirePerm } from '#lib/server/rbac/access.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const m = requirePerm(locals, 'announcement.manage');
	return assistJson(async () => draftAnnouncement(m, await formOf(request)));
};
