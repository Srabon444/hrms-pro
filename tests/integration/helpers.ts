import { randomUUID } from 'node:crypto';
import { ownerPool } from '../../src/lib/server/db';
import { DEMO_LOCALE } from '../../src/lib/server/demo-seed';

export const TEST_LOCALE = DEMO_LOCALE;

export async function createTenant(prefix = 't'): Promise<{ id: string; slug: string }> {
	const slug = `${prefix}-${randomUUID().slice(0, 8)}`;
	const [row] = await ownerPool().sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${slug}, ${slug}) returning id`;
	const { timezone, currency, fiscalYearStartMonth, weekendDays } = TEST_LOCALE;
	await ownerPool().sql`
		insert into tenant_settings (tenant_id, timezone, currency, fiscal_year_start_month, weekend_days)
		values (${row.id}, ${timezone}, ${currency}, ${fiscalYearStartMonth}, ${weekendDays})`;
	return { id: row.id, slug };
}

export async function createUser(
	email = `${randomUUID().slice(0, 8)}@test.local`
): Promise<{ id: string; email: string }> {
	const [row] = await ownerPool().sql<{ id: string }[]>`
		insert into users (email, password_hash, name) values (${email}, 'x', ${email}) returning id`;
	return { id: row.id, email };
}
