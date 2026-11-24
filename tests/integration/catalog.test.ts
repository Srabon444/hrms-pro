import { afterAll, describe, expect, it } from 'vitest';
import { closePools, ownerPool } from '../../src/lib/server/db';

afterAll(closePools);

const tenantTables = async () =>
	(
		await ownerPool().sql<{ table_name: string }[]>`
			select c.table_name from information_schema.columns c
			join information_schema.tables t using (table_schema, table_name)
			where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
			order by 1`
	).map((r) => r.table_name);

describe('schema catalog', () => {
	it('every tenant table forces RLS and carries the restrictive tenant policy', async () => {
		const tables = await tenantTables();
		expect(tables.length).toBeGreaterThan(5);
		const rows = await ownerPool().sql<{ relname: string; rls: boolean; force: boolean; restrictive: boolean }[]>`
			select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force,
				exists (select 1 from pg_policies p where p.tablename = c.relname and p.policyname = 'hrms_tenant'
					and p.permissive = 'RESTRICTIVE' and 'hrms_app' = any(p.roles)) as restrictive
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = 'public' and c.relname = any(${tables})`;
		const bad = rows.filter((r) => !r.rls || !r.force || !r.restrictive).map((r) => r.relname);
		expect(bad).toEqual([]);
	});

	it('every tenant table is classified in audit_registry', async () => {
		const tables = await tenantTables();
		const reg = (await ownerPool().sql<{ table_name: string }[]>`select table_name from audit_registry`).map(
			(r) => r.table_name
		);
		expect(tables.filter((t) => !reg.includes(t))).toEqual([]);
	});

	it('foreign keys between tenant tables are composite and never set null', async () => {
		const rows = await ownerPool().sql<
			{ conname: string; child: string; parent: string; cols: number; deltype: string }[]
		>`
			select con.conname, ch.relname as child, pa.relname as parent, cardinality(con.conkey) as cols, con.confdeltype as deltype
			from pg_constraint con
			join pg_class ch on ch.oid = con.conrelid
			join pg_class pa on pa.oid = con.confrelid
			join pg_namespace n on n.oid = ch.relnamespace
			where con.contype = 'f' and n.nspname = 'public'`;
		expect(rows.filter((r) => r.deltype === 'n' || r.deltype === 'd').map((r) => r.conname)).toEqual([]);
		const tables = await tenantTables();
		const singleColumnTenantFks = rows.filter(
			(r) =>
				tables.includes(r.child) && tables.includes(r.parent) && r.cols < 2 && r.conname !== 'audit_sensitive_audit_fk'
		);
		expect(singleColumnTenantFks.map((r) => r.conname)).toEqual([]);
	});

	it('runtime roles cannot bypass RLS and hrms_app cannot touch global auth tables', async () => {
		const roles = await ownerPool().sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
			select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('hrms_app', 'hrms_auth')`;
		expect(roles).toHaveLength(2);
		for (const r of roles) expect([r.rolsuper, r.rolbypassrls]).toEqual([false, false]);
		const [priv] = await ownerPool().sql<{ users: boolean; sessions: boolean; audit_update: boolean }[]>`
			select has_table_privilege('hrms_app', 'users', 'select') as users,
				has_table_privilege('hrms_app', 'sessions', 'select') as sessions,
				has_table_privilege('hrms_app', 'audit_log', 'update') as audit_update`;
		expect(priv).toEqual({ users: false, sessions: false, audit_update: false });
	});

	it('security definer functions pin search_path and are not executable by public', async () => {
		const rows = await ownerPool().sql<{ proname: string; config: string[] | null; public_exec: boolean }[]>`
			select p.proname, p.proconfig as config,
				has_function_privilege('public', p.oid, 'execute') as public_exec
			from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			where n.nspname = 'public' and p.prosecdef`;
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) {
			expect(r.config ?? [], r.proname).toContain('search_path=pg_catalog, public, pg_temp');
			expect(r.public_exec, r.proname).toBe(false);
		}
	});
});
