import postgres from 'postgres';

function swapDb(url: string | undefined, db: string): string {
	if (!url) throw new Error('database url missing from .env');
	const u = new URL(url);
	u.pathname = `/${db}`;
	return u.toString();
}

export function testEnv(db: string, extra: Record<string, string> = {}): Record<string, string> {
	try {
		process.loadEnvFile();
	} catch {
		void 0;
	}
	const e = process.env;
	return {
		DATABASE_URL: swapDb(e.DATABASE_URL, db),
		AUTH_DATABASE_URL: swapDb(e.AUTH_DATABASE_URL, db),
		OWNER_DATABASE_URL: swapDb(e.OWNER_DATABASE_URL, db),
		REDIS_PREFIX: db,
		S3_BUCKET: db.replace(/_/g, '-'),
		TEST_MODE: '1',
		NODE_ENV: 'test',
		LOG_LEVEL: 'warn',
		...extra
	};
}

export async function prepareDatabase(env: Record<string, string>): Promise<void> {
	const owner = new URL(env.OWNER_DATABASE_URL);
	const db = owner.pathname.slice(1);
	if (!/^hrms_[a-z0-9_]+$/.test(db) || db === 'hrms') throw new Error(`refusing to reset database ${db}`);
	owner.pathname = '/postgres';
	const admin = postgres(owner.toString(), { max: 1, onnotice: () => {} });
	try {
		await admin.unsafe(`drop database if exists ${db} with (force)`);
		await admin.unsafe(`create database ${db}`);
	} finally {
		await admin.end();
	}
	Object.assign(process.env, env);
	const { migrateDatabase } = await import('../src/lib/server/db/migrate');
	const { ensureBucket } = await import('../src/lib/server/storage');
	const { closePools } = await import('../src/lib/server/db');
	try {
		await migrateDatabase();
		await ensureBucket();
	} finally {
		await closePools();
	}
}
