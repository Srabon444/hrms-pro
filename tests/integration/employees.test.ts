import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GrantMap } from '../../src/lib/rbac/grants';
import { closePools, ownerPool } from '../../src/lib/server/db';
import {
	createEmployee,
	EMPLOYMENT_FIELDS,
	getEmployee,
	listEmployees,
	PROFILE_FIELDS,
	updateEmployee
} from '../../src/lib/server/employees';
import { addOrgItem } from '../../src/lib/server/org';
import { seedTenant } from '../../src/lib/server/platform/tenants';
import type { Access } from '../../src/lib/server/rbac/access';
import { resolveScope } from '../../src/lib/server/rbac/scope';
import { withTenant, type TenantCtx } from '../../src/lib/server/tenancy';
import { createTenant, TEST_LOCALE } from './helpers';

let ctx: TenantCtx;
let other: TenantCtx;
const ids: Record<string, string> = {};
const dept: Record<string, string> = {};

const access = (employeeId: string | null, grants: GrantMap): Access => ({
	membershipId: crypto.randomUUID(),
	employeeId,
	grants,
	roleKeys: [],
	isOwner: false
});
const hr = access(null, {
	'employee.read': ['all'],
	'employee.create': ['all'],
	'employee.update': ['all'],
	'employee.sensitive.read': ['all'],
	'employee.sensitive.update': ['all']
});
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const person = (fullName: string, extra: Record<string, string> = {}) => ({
	...blanks,
	fullName,
	employmentType: 'full_time',
	status: 'active',
	joinDate: '2026-01-05',
	...extra
});
const visible = async (a: Access) =>
	withTenant(ctx, async (tx) => {
		const s = await resolveScope(tx, a, 'employee.read');
		return s.kind === 'all'
			? 'all'
			: Object.keys(ids)
					.filter((k) => s.ids.includes(ids[k]))
					.sort();
	});

beforeAll(async () => {
	for (const prefix of ['emp-a', 'emp-b']) {
		const t = await createTenant(prefix);
		await withTenant({ tenantId: t.id, actor: 'system' }, (tx) => seedTenant(tx, t.id, TEST_LOCALE));
		if (prefix === 'emp-a') ctx = { tenantId: t.id, actor: 'user' };
		else other = { tenantId: t.id, actor: 'user' };
	}
	dept.eng = await addOrgItem(ctx, 'department', { name: 'Engineering' });
	dept.web = await addOrgItem(ctx, 'department', { name: 'Web', parentId: dept.eng });
	dept.sales = await addOrgItem(ctx, 'department', { name: 'Sales' });
	ids.head = await createEmployee(ctx, hr, person('Hana Head', { departmentId: dept.eng }));
	ids.dev = await createEmployee(ctx, hr, person('Dev One', { departmentId: dept.web, managerId: ids.head }));
	ids.junior = await createEmployee(ctx, hr, person('Junior Two', { departmentId: dept.web, managerId: ids.dev }));
	ids.sales = await createEmployee(
		ctx,
		hr,
		person('Sam Sales', { departmentId: dept.sales, nationalId: '1990123456789', bankAccountNumber: '0011223344' })
	);
});

afterAll(closePools);

describe('employee scope', () => {
	it('team covers every level of reports and the manager themself', async () => {
		expect(await visible(access(ids.head, { 'employee.read': ['team'] }))).toEqual(['dev', 'head', 'junior']);
		expect(await visible(access(ids.dev, { 'employee.read': ['team'] }))).toEqual(['dev', 'junior']);
	});

	it('department covers sub-departments; own covers only oneself', async () => {
		expect(await visible(access(ids.head, { 'employee.read': ['department'] }))).toEqual(['dev', 'head', 'junior']);
		expect(await visible(access(ids.sales, { 'employee.read': ['own'] }))).toEqual(['sales']);
		expect(await visible(access(ids.sales, { 'employee.read': ['own', 'team'] }))).toEqual(['sales']);
	});

	it('a member without an employee record sees nobody unless scope is all', async () => {
		expect(await visible(access(null, { 'employee.read': ['team', 'department'] }))).toEqual([]);
		expect(await visible(access(null, { 'employee.read': ['all'] }))).toBe('all');
	});

	it('survives a reporting loop already in the data', async () => {
		await ownerPool().sql`update employees set manager_id = ${ids.junior} where id = ${ids.head}`;
		try {
			expect(await visible(access(ids.dev, { 'employee.read': ['team'] }))).toEqual(['dev', 'head', 'junior']);
		} finally {
			await ownerPool().sql`update employees set manager_id = null where id = ${ids.head}`;
		}
	});
});

describe('employee records', () => {
	it('numbers employees with the tenant prefix, also under concurrency', async () => {
		const made = await Promise.all([1, 2, 3, 4].map((n) => createEmployee(ctx, hr, person(`Batch ${n}`))));
		const codes = await withTenant(ctx, async (tx) =>
			Promise.all(made.map(async (id) => (await getEmployee(tx, hr, id))!.employee.code))
		);
		expect(new Set(codes).size).toBe(4);
		expect(codes.every((c) => /^EMP-\d{4}$/.test(c))).toBe(true);
	});

	it('hides identity and bank details without employee.sensitive.read', async () => {
		const reader = access(null, { 'employee.read': ['all'] });
		const plain = await withTenant(ctx, (tx) => getEmployee(tx, reader, ids.sales));
		expect(plain!.sensitive).toBeNull();
		expect(JSON.stringify(plain)).not.toContain('1990123456789');
		const full = await withTenant(ctx, (tx) => getEmployee(tx, hr, ids.sales));
		expect(full!.sensitive!.nationalId).toBe('1990123456789');
	});

	it('returns nothing for people outside the reader scope', async () => {
		const manager = access(ids.head, { 'employee.read': ['team'] });
		expect(await withTenant(ctx, (tx) => getEmployee(tx, manager, ids.sales))).toBeNull();
		expect(await withTenant(ctx, (tx) => getEmployee(tx, manager, 'not-a-uuid'))).toBeNull();
	});

	it('a department head cannot move people out of their department or touch bank details', async () => {
		const deptHead = access(ids.head, { 'employee.read': ['department'], 'employee.update': ['department'] });
		const base = person('Dev One', { departmentId: dept.web, managerId: ids.head });
		expect(await code(updateEmployee(ctx, deptHead, ids.dev, { ...base, departmentId: dept.sales }, 'acme'))).toBe(
			'out_of_scope'
		);
		expect(await code(updateEmployee(ctx, deptHead, ids.dev, { ...base, bankAccountNumber: '999' }, 'acme'))).toBe(
			'sensitive_denied'
		);
		expect(await code(updateEmployee(ctx, deptHead, ids.sales, person('Sam Sales'), 'acme'))).toBe('not_found');
		expect(await code(updateEmployee(ctx, deptHead, ids.dev, { ...base, phone: '01700000000' }, 'acme'))).toBe('ok');
	});

	it('refuses reporting loops and records history with names', async () => {
		expect(
			await code(
				updateEmployee(
					ctx,
					hr,
					ids.head,
					person('Hana Head', { departmentId: dept.eng, managerId: ids.junior }),
					'acme'
				)
			)
		).toBe('manager_cycle');
		await updateEmployee(
			ctx,
			hr,
			ids.junior,
			person('Junior Two', { departmentId: dept.eng, managerId: ids.head }),
			'acme'
		);
		const rec = await withTenant(ctx, (tx) => getEmployee(tx, hr, ids.junior));
		const changes = rec!.history.map((h) => `${h.field}:${h.oldValue}->${h.newValue}`).sort();
		expect(changes).toEqual([
			'departmentId:Web->Engineering',
			expect.stringMatching(/^managerId:Dev One \(EMP-\d+\)->Hana Head/)
		]);
	});

	it('rejects references from another organisation and invalid values', async () => {
		const foreign = await addOrgItem(other, 'department', { name: 'Elsewhere' });
		expect(await code(createEmployee(ctx, hr, person('Wrong Dept', { departmentId: foreign })))).toBe(
			'invalid_reference'
		);
		expect(await code(createEmployee(ctx, hr, person('Exited', { status: 'exited' })))).toBe('invalid');
		expect(await code(createEmployee(ctx, hr, person('Bad Mail', { workEmail: 'nope' })))).toBe('invalid');
		await createEmployee(ctx, hr, person('Mail One', { workEmail: 'same@acme.test' }));
		expect(await code(createEmployee(ctx, hr, person('Mail Two', { workEmail: 'SAME@acme.test' })))).toBe(
			'duplicate_email'
		);
	});

	it('a creator with department scope can only add people to their department', async () => {
		const deptHead = access(ids.head, { 'employee.create': ['department'] });
		expect(await code(createEmployee(ctx, deptHead, person('In Web', { departmentId: dept.web })))).toBe('ok');
		expect(await code(createEmployee(ctx, deptHead, person('In Sales', { departmentId: dept.sales })))).toBe(
			'out_of_scope'
		);
	});

	it('lists within scope with search, filter and paging', async () => {
		const manager = access(ids.head, { 'employee.read': ['team'] });
		const mine = await withTenant(ctx, (tx) => listEmployees(tx, manager, {}));
		expect(mine.rows.map((r) => r.fullName).sort()).toEqual(['Dev One', 'Hana Head', 'Junior Two']);
		const found = await withTenant(ctx, (tx) => listEmployees(tx, hr, { q: 'sam sa' }));
		expect(found.rows.map((r) => r.fullName)).toEqual(['Sam Sales']);
		const wild = await withTenant(ctx, (tx) => listEmployees(tx, hr, { q: '%' }));
		expect(wild.total).toBe(0);
		const sales = await withTenant(ctx, (tx) => listEmployees(tx, hr, { department: dept.sales, page: 'abc' }));
		expect(sales.rows.map((r) => r.fullName)).toEqual(['Sam Sales']);
		expect(sales.filters.page).toBe(1);
	});
});
