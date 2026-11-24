import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { config } from '../config';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;

type Pool = { sql: postgres.Sql; db: Db };

const pools = new Map<string, Pool>();

function pool(name: 'app' | 'auth' | 'owner', url: string | undefined, max: number): Pool {
	const existing = pools.get(name);
	if (existing) return existing;
	if (!url) throw new Error(`Database URL for pool "${name}" is not configured`);
	const sql = postgres(url, {
		max,
		idle_timeout: 30,
		connect_timeout: 10,
		onnotice: () => {},
		connection: { application_name: `hrms-${name}` }
	});
	const created = { sql, db: drizzle(sql, { schema, casing: 'snake_case' }) };
	pools.set(name, created);
	return created;
}

export const appPool = () => pool('app', config().DATABASE_URL, config().DB_POOL_MAX);
export const authPool = () =>
	pool('auth', config().AUTH_DATABASE_URL, Math.max(2, Math.floor(config().DB_POOL_MAX / 2)));
export const ownerPool = () => pool('owner', config().OWNER_DATABASE_URL, 3);

export async function closePools(): Promise<void> {
	await Promise.all([...pools.values()].map((p) => p.sql.end({ timeout: 5 })));
	pools.clear();
}

export { schema };
