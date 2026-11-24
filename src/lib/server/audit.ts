import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { can, userCtx, type requireMember } from './rbac/access';
import { auditLog } from './db/schema';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

export const AUDIT_PAGE_SIZE = 50;

export const auditEvent = (
	tx: Tx,
	ctx: TenantCtx,
	tableName: string,
	rowId: string | null,
	event: string,
	details: Record<string, string> | null = null
) =>
	tx.insert(auditLog).values({
		tenantId: ctx.tenantId,
		actorUserId: ctx.userId ?? null,
		actorKind: ctx.actor,
		tableName,
		rowId,
		op: 'READ',
		event,
		newValues: details
	});

type Values = Record<string, unknown> | null;

type Row = {
	id: string;
	created_at: Date;
	actor_kind: string;
	actor_name: string | null;
	table_name: string;
	row_id: string | null;
	op: string;
	event: string | null;
	changed_columns: string[];
	old_values: Values;
	new_values: Values;
	sensitive_old: Values;
	sensitive_new: Values;
};

export type AuditChange = { column: string; before: string; after: string };

export type AuditEntry = {
	id: string;
	at: Date;
	actor: string;
	table: string;
	rowId: string | null;
	op: string;
	event: string | null;
	changes: AuditChange[];
};

const show = (v: unknown) => (v === undefined ? '' : JSON.stringify(v));

const filterSchema = z.object({
	table: z.string().max(63).optional(),
	before: z.uuid().optional()
});

export async function listAudit(
	m: ReturnType<typeof requireMember>,
	raw: { table?: string | null; before?: string | null }
): Promise<{ tables: string[]; entries: AuditEntry[]; next: string | null; table: string }> {
	const parsed = filterSchema.safeParse({ table: raw.table || undefined, before: raw.before || undefined });
	const filter = parsed.success ? parsed.data : {};
	const sensitive = can(m.access, 'audit.sensitive');
	return withTenant(userCtx(m, { auditSensitive: sensitive }), async (tx) => {
		const tables = (
			await tx.execute<{ table_name: string }>(sql`select table_name from audit_registry order by table_name`)
		).map((t) => t.table_name);
		const table = filter.table && tables.includes(filter.table) ? filter.table : '';
		const rows = await tx.execute<Row>(sql`
			select a.id, a.created_at, a.actor_kind, u.name as actor_name, a.table_name, a.row_id, a.op, a.event,
				a.changed_columns, a.old_values, a.new_values, s.old_values as sensitive_old, s.new_values as sensitive_new
			from audit_log a
			left join lateral (select name from tenant_users where user_id = a.actor_user_id limit 1) u on true
			left join audit_sensitive s on s.audit_id = a.id
			where (${table} = '' or a.table_name = ${table})
				and (${filter.before ?? null}::uuid is null
					or (a.created_at, a.id) < (select b.created_at, b.id from audit_log b where b.id = ${filter.before ?? null}::uuid))
			order by a.created_at desc, a.id desc
			limit ${AUDIT_PAGE_SIZE + 1}`);
		const page = rows.slice(0, AUDIT_PAGE_SIZE);
		return {
			tables,
			table,
			next: rows.length > AUDIT_PAGE_SIZE ? page[page.length - 1].id : null,
			entries: page.map((r) => {
				const before = (sensitive && r.sensitive_old) || r.old_values || {};
				const after = (sensitive && r.sensitive_new) || r.new_values || {};
				return {
					id: r.id,
					at: new Date(r.created_at),
					actor: r.actor_name ?? (r.actor_kind === 'system' ? 'System' : 'Unknown'),
					table: r.table_name,
					rowId: r.row_id,
					op: r.op,
					event: r.event,
					changes: r.changed_columns.map((column) => ({
						column,
						before: show(before[column]),
						after: show(after[column])
					}))
				};
			})
		};
	});
}
