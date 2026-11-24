import { error } from '@sveltejs/kit';
import { AppError } from '#lib/server/errors.ts';
import { openPayslipPdf } from '#lib/server/payroll.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import { downloadLimit } from '#lib/server/ratelimit.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const m = requireMember(locals);
	const limited = await downloadLimit(m.user.userId);
	if (limited) return limited;
	try {
		const pdf = await openPayslipPdf(m, params.payslipId);
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
