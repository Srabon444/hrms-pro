import { error } from '@sveltejs/kit';
import { AppError } from '#lib/server/errors.ts';
import { requestFile } from '#lib/server/esign.ts';
import { requireModule } from '#lib/server/modules.ts';
import { downloadLimit } from '#lib/server/ratelimit.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const m = await requireModule(locals, 'esign');
	const limited = await downloadLimit(m.user.userId);
	if (limited) return limited;
	try {
		const f = await requestFile(m, params.requestId, params.kind);
		return new Response(new Uint8Array(f.body), {
			headers: {
				'content-type': 'application/pdf',
				'content-length': String(f.body.byteLength),
				'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
				'x-content-type-options': 'nosniff',
				'cache-control': 'private, no-store'
			}
		});
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	}
};
