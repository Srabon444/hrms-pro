import { fail } from '@sveltejs/kit';
import { ImportFailed } from '../csv';
import { AppError } from '../errors';
import { log } from '../log';

export const field = (form: FormData, name: string): string => {
	const v = form.get(name);
	return typeof v === 'string' ? v : '';
};

export function actionError(err: unknown, requestId: string) {
	if (err instanceof ImportFailed) return fail(400, { message: err.message, rows: err.rows });
	if (err instanceof AppError) return fail(err.status, { message: err.message });
	log.error({ err, requestId }, 'action failed');
	return fail(503, { message: 'The service is temporarily unavailable. Please try again shortly.' });
}

export const limitedMessage = (retryAfter: number) =>
	`Too many attempts. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`;
