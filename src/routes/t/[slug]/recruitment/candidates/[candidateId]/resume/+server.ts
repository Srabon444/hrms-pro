import { error } from '@sveltejs/kit';
import { AppError } from '#lib/server/errors.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { downloadLimit } from '#lib/server/ratelimit.ts';
import { openResume } from '#lib/server/recruitment.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const m = requirePerm(locals, 'recruitment.read');
	const limited = await downloadLimit(m.user.userId);
	if (limited) return limited;
	try {
		const r = await openResume(userCtx(m), params.candidateId);
		return new Response(new Uint8Array(r.body), {
			headers: {
				'content-type': r.contentType,
				'content-length': String(r.body.byteLength),
				'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.fileName)}`,
				'x-content-type-options': 'nosniff',
				'cache-control': 'private, no-store'
			}
		});
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	}
};
