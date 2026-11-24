import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GrantMap } from '../../src/lib/rbac/grants';
import { parseCsv, toCsv } from '../../src/lib/server/csv';
import { closePools } from '../../src/lib/server/db';
import { ImportFailed } from '../../src/lib/server/csv';
import { exportEmployees, importEmployees, listEmployees } from '../../src/lib/server/employees';
import { addOrgItem } from '../../src/lib/server/org';
import { seedTenant } from '../../src/lib/server/platform/tenants';
import type { Access } from '../../src/lib/server/rbac/access';
import { withTenant, type TenantCtx } from '../../src/lib/server/tenancy';
import { createTenant } from './helpers';

let ctx: TenantCtx;
const dept: Record<string, string> = {};
const access = (employeeId: string | null, grants: GrantMap): Access => ({
	membershipId: crypto.randomUUID(),
	employeeId,
	grants,
	roleKeys: [],
	isOwner: false
});
const hr = access(null, { 'employee.read': ['all'], 'employee.create': ['all'] });
const HEADER = 'full_name,work_email,department,manager_email,employment_type,status,join_date';
const csv = (...lines: string[]) => parseCsv([HEADER, ...lines].join('\n'));
const total = async () => (await withTenant(ctx, (tx) => listEmployees(tx, hr, {}))).total;
const failure = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: unknown) => (e instanceof ImportFailed ? e.rows : Promise.reject(e))
	);

beforeAll(async () => {
	const t = await createTenant('csv');
	await withTenant({ tenantId: t.id, actor: 'system' }, (tx) => seedTenant(tx, t.id));
	ctx = { tenantId: t.id, actor: 'user' };
	dept.eng = await addOrgItem(ctx, 'department', { name: 'Engineering' });
	dept.sales = await addOrgItem(ctx, 'department', { name: 'Sales' });
});

afterAll(closePools);

describe('employee CSV import', () => {
	it('adds every row, matching departments by name and managers by earlier rows', async () => {
		const n = await importEmployees(
			ctx,
			hr,
			csv(
				'Mina Lead,mina@csv.test,engineering,,full_time,active,2026-01-01',
				'Tareq Dev,tareq@csv.test,ENGINEERING,MINA@csv.test,contract,probation,2026-02-01',
				"'=Odd Name,,Sales,,intern,onboarding,2026-03-01"
			)
		);
		expect(n).toBe(3);
		const rows = await withTenant(ctx, (tx) => exportEmployees(tx, hr, { sort: 'joined' }));
		expect(rows[0].slice(0, 3)).toEqual(['code', 'full_name', 'work_email']);
		const tareq = rows.find((r) => r[1] === 'Tareq Dev')!;
		expect(tareq[7]).toBe('Engineering');
		expect(tareq[11]).toBe('mina@csv.test');
		expect(rows.some((r) => r[1] === '=Odd Name')).toBe(true);
		expect(toCsv(rows)).toContain("'=Odd Name");
	});

	it('adds nothing when any row is wrong and reports every bad line', async () => {
		const before = await total();
		const rows = await failure(
			importEmployees(
				ctx,
				hr,
				csv(
					'Good One,good@csv.test,Sales,,full_time,active,2026-01-01',
					'Bad Dept,,Marketing,,full_time,active,2026-01-01',
					'Bad Mail,not-an-email,,,full_time,active,2026-01-01',
					'Twin,good@csv.test,,,full_time,active,2026-01-01',
					'Gone,,,,full_time,exited,2026-01-01',
					'Orphan,,,later@csv.test,full_time,active,2026-01-01',
					'Later,later@csv.test,,,full_time,active,2026-01-01'
				)
			)
		);
		expect(rows!.map((r) => r.line)).toEqual([3, 4, 5, 6, 7]);
		expect(rows![0].message).toContain('Unknown department "Marketing"');
		expect(rows![1].message).toMatch(/^work_email:/);
		expect(rows![2].message).toContain('already uses that work email');
		expect(rows![4].message).toContain('list managers before their reports');
		expect(await total()).toBe(before);
	});

	it('rejects a bad header, an empty file and oversized files', async () => {
		expect((await failure(importEmployees(ctx, hr, parseCsv('name,salary\nX,1'))))![0].line).toBe(1);
		expect(await failure(importEmployees(ctx, hr, parseCsv(HEADER)))).toEqual([
			{ line: 2, message: 'The file has no rows to import.' }
		]);
		const many = Array.from({ length: 2001 }, (_, i) => `P${i},,,,full_time,active,2026-01-01`);
		expect((await failure(importEmployees(ctx, hr, csv(...many))))![0].message).toContain('at most 2000');
	});

	it('keeps a department-scoped creator inside their department', async () => {
		const [lead] = await withTenant(ctx, (tx) => exportEmployees(tx, hr, { q: 'mina' })).then((r) => r.slice(1));
		const leadId = (await withTenant(ctx, (tx) => listEmployees(tx, hr, { q: String(lead[0]) }))).rows[0].id;
		const scoped = access(leadId, { 'employee.create': ['department'], 'employee.read': ['department'] });
		const before = await total();
		const rows = await failure(
			importEmployees(
				ctx,
				scoped,
				csv('In Eng,,Engineering,,full_time,active,2026-01-01', 'In Sales,,Sales,,full_time,active,2026-01-01')
			)
		);
		expect(rows).toEqual([{ line: 3, message: 'You can only add people within your own scope.' }]);
		expect(await total()).toBe(before);
		const visible = await withTenant(ctx, (tx) => exportEmployees(tx, scoped, {}));
		expect(visible.slice(1).every((r) => r[7] === 'Engineering')).toBe(true);
	});
});
