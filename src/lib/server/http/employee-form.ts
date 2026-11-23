import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { actionError } from './forms';

export const formFields = (form: FormData): Record<string, string> =>
	Object.fromEntries([...form.entries()].filter((e): e is [string, string] => typeof e[1] === 'string'));

export function employeeActionError(err: unknown, requestId: string, values: Record<string, string>) {
	if (err instanceof z.ZodError) return fail(400, { message: err.issues[0].message, values });
	const failed = actionError(err, requestId);
	return fail(failed.status, { ...failed.data, values });
}
