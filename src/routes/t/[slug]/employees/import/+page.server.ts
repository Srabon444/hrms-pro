import { fail } from '@sveltejs/kit';
import { parseCsv } from '#lib/server/csv.ts';
import { CSV_COLUMNS, ImportFailed, importEmployees } from '#lib/server/employees.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import type { Actions, PageServerLoad } from './$types';

const MAX_BYTES = 1024 * 1024;

export const load: PageServerLoad = async ({ locals }) => {
	requirePerm(locals, 'employee.create');
	return { columns: CSV_COLUMNS };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const m = requirePerm(locals, 'employee.create');
		const file = (await request.formData()).get('file');
		if (!(file instanceof File) || file.size === 0) return fail(400, { message: 'Choose a CSV file.' });
		if (file.size > MAX_BYTES) return fail(413, { message: 'CSV files can be at most 1 MB.' });
		let table: string[][];
		try {
			table = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
		} catch {
			return fail(400, { message: 'That file is not a valid UTF-8 CSV.' });
		}
		try {
			return { imported: await importEmployees(userCtx(m), m.access, table) };
		} catch (err) {
			if (err instanceof ImportFailed) return fail(400, { message: err.message, rows: err.rows });
			return actionError(err, locals.requestId);
		}
	}
};
