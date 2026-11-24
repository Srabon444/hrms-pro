import { readCsvUpload } from '#lib/server/csv.ts';
import { CSV_COLUMNS, importEmployees } from '#lib/server/employees.ts';
import { actionError } from '#lib/server/http/forms.ts';
import { requirePerm, userCtx } from '#lib/server/rbac/access.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePerm(locals, 'employee.create');
	return { columns: CSV_COLUMNS };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const m = requirePerm(locals, 'employee.create');
		try {
			const table = await readCsvUpload((await request.formData()).get('file'));
			return { imported: await importEmployees(userCtx(m), m.access, table) };
		} catch (err) {
			return actionError(err, locals.requestId);
		}
	}
};
