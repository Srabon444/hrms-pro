import { error } from '@sveltejs/kit';
import { openDocument } from '#lib/server/documents.ts';
import { AppError } from '#lib/server/errors.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import { downloadLimit } from '#lib/server/ratelimit.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const m = requirePerm(locals, 'document.read');
	const limited = await downloadLimit(m.user.userId);
	if (limited) return limited;
	try {
		const doc = await openDocument(userCtx(m), m.access, params.employeeId, params.documentId);
		return new Response(new Uint8Array(doc.body), {
			headers: {
				'content-type': doc.contentType,
				'content-length': String(doc.body.byteLength),
				'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
				'x-content-type-options': 'nosniff',
				'cache-control': 'private, no-store'
			}
		});
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	}
};
