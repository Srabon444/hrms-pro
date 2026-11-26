import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { chartChildren, chartPathTo, departmentLevel } from '#lib/server/directory.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { RequestHandler } from './$types';

const id = z.uuid();

export const GET: RequestHandler = async ({ locals, url }) => {
	const m = await requireModule(locals, 'directory', 'directory.read');
	const of = id.safeParse(url.searchParams.get('of'));
	const dept = url.searchParams.get('dept');
	return withTenant(userCtx(m), async (tx) => {
		if (of.success) return json({ nodes: await chartChildren(tx, [of.data]) });
		if (url.searchParams.get('path') === 'me')
			return json(m.access.employeeId ? await chartPathTo(tx, m.access.employeeId) : { chain: [], children: [] });
		if (dept === 'root') return json(await departmentLevel(tx, null));
		const d = id.safeParse(dept);
		if (d.success) return json(await departmentLevel(tx, d.data));
		return json({ message: 'Unknown request.' }, { status: 400 });
	});
};
