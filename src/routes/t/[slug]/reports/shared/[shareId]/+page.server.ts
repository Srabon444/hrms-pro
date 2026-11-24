import { error } from '@sveltejs/kit';
import { AppError } from '#lib/server/errors.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import { openShare } from '#lib/server/reports/shares.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	try {
		return await openShare(requireMember(locals), params.shareId);
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	}
};
