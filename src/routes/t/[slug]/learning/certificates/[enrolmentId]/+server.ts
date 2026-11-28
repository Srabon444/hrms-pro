import { error } from '@sveltejs/kit';
import { AppError } from '#lib/server/errors.ts';
import { certificatePdf } from '#lib/server/learning.ts';
import { requireModule } from '#lib/server/modules.ts';
import { downloadLimit } from '#lib/server/ratelimit.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const m = await requireModule(locals, 'learning');
	const limited = await downloadLimit(m.user.userId);
	if (limited) return limited;
	try {
		const pdf = await certificatePdf(m, params.enrolmentId);
		return new Response(new Uint8Array(pdf.body), {
			headers: {
				'content-type': 'application/pdf',
				'content-length': String(pdf.body.byteLength),
				'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(pdf.fileName)}`,
				'x-content-type-options': 'nosniff',
				'cache-control': 'private, no-store'
			}
		});
	} catch (err) {
		if (err instanceof AppError) error(err.status, err.message);
		throw err;
	}
};
