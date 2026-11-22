import { customType, foreignKey, timestamp, unique, uuid, type AnyPgColumn, type PgColumn } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const citext = customType<{ data: string }>({ dataType: () => 'citext' });

export const tstz = () => timestamp({ withTimezone: true, mode: 'date' });

export const createdAt = () => tstz().notNull().defaultNow();
export const updatedAt = () =>
	tstz()
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date());

export const tenantId = () =>
	uuid()
		.notNull()
		.references(() => tenants.id, { onDelete: 'restrict' });

export const tenantBase = () => ({
	id: uuid().primaryKey().defaultRandom(),
	tenantId: tenantId(),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

export const tenantKey = (table: string, t: { tenantId: PgColumn; id: PgColumn }) =>
	unique(`${table}_tenant_id_id_uq`).on(t.tenantId, t.id);

type TenantParent = { tenantId: AnyPgColumn; id: AnyPgColumn };

export function tfk(
	name: string,
	t: { tenantId: PgColumn },
	column: PgColumn,
	parent: TenantParent,
	onDelete: 'cascade' | 'restrict' | 'no action' = 'no action'
) {
	return foreignKey({
		name,
		columns: [t.tenantId, column],
		foreignColumns: [parent.tenantId, parent.id]
	}).onDelete(onDelete);
}
