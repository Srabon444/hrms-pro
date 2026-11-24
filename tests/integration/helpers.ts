import { randomUUID } from 'node:crypto';
import { ownerPool } from '../../src/lib/server/db';

export async function createTenant(prefix = 't'): Promise<{ id: string; slug: string }> {
	const slug = `${prefix}-${randomUUID().slice(0, 8)}`;
	const [row] = await ownerPool().sql<{ id: string }[]>`
		insert into tenants (slug, name) values (${slug}, ${slug}) returning id`;
	await ownerPool().sql`insert into tenant_settings (tenant_id) values (${row.id})`;
	return { id: row.id, slug };
}

export async function createUser(
	email = `${randomUUID().slice(0, 8)}@test.local`
): Promise<{ id: string; email: string }> {
	const [row] = await ownerPool().sql<{ id: string }[]>`
		insert into users (email, password_hash, name) values (${email}, 'x', ${email}) returning id`;
	return { id: row.id, email };
}
