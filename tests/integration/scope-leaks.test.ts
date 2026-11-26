import { afterAll, beforeAll, describe, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import { exportEmployees, listEmployees } from '../../src/lib/server/employees';
import { userCtx } from '../../src/lib/server/rbac/access';
import { globalSearch } from '../../src/lib/server/search';
import { withTenant } from '../../src/lib/server/tenancy';
import { expectScoped, leakWorld, type LeakWorld, type Member } from './leak';

let world: LeakWorld;
const read = <T>(m: Member, fn: Parameters<typeof withTenant<T>>[1]) =>
	withTestNow(world.now, () => withTenant(userCtx(m), fn));

beforeAll(async () => {
	world = await leakWorld(['employee.read']);
});

afterAll(closePools);

describe('employee reads stay inside scope and tenant', () => {
	it('lists only employees the viewer may read', () =>
		expectScoped(world, (m) => read(m, async (tx) => (await listEmployees(tx, m.access, {})).rows.map((r) => r.id))));

	it('exports only employees the viewer may read', () =>
		expectScoped(world, async (m) => {
			const [header, ...rows] = await read(m, (tx) => exportEmployees(tx, m.access, {}));
			return rows.map((r) => world.byName[String(r[header.indexOf('full_name')])]);
		}));

	it('searches only employees the viewer may read', () =>
		expectScoped(world, (m) =>
			read(m, async (tx) =>
				(await globalSearch(tx, { access: m.access, active: true }, 'leak'))
					.filter((h) => h.kind === 'employee')
					.map((h) => h.id)
			)
		));
});
