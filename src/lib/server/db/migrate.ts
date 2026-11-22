import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { config } from '../config';
import { ownerPool } from './index';

const root = (rel: string) => fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));

async function runSqlFile(rel: string, settings: Record<string, string> = {}): Promise<void> {
	const text = await readFile(root(rel), 'utf8');
	const conn = await ownerPool().sql.reserve();
	try {
		for (const [k, v] of Object.entries(settings)) await conn`select set_config(${k}, ${v}, false)`;
		await conn.unsafe(text);
	} finally {
		for (const k of Object.keys(settings)) await conn`select set_config(${k}, '', false)`.catch(() => {});
		conn.release();
	}
}

export async function migrateDatabase(): Promise<void> {
	const appPw = process.env.HRMS_APP_DB_PASSWORD;
	const authPw = process.env.HRMS_AUTH_DB_PASSWORD;
	if (!appPw || !authPw) throw new Error('HRMS_APP_DB_PASSWORD and HRMS_AUTH_DB_PASSWORD are required');
	if (!config().OWNER_DATABASE_URL) throw new Error('OWNER_DATABASE_URL is required for migrations');
	await runSqlFile('scripts/pre-migrate.sql', { 'hrms.app_pw': appPw, 'hrms.auth_pw': authPw });
	await migrate(ownerPool().db, { migrationsFolder: root('drizzle') });
	await runSqlFile('scripts/registry.sql');
	await runSqlFile('scripts/post-migrate.sql');
}
