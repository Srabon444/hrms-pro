import { defineConfig } from 'drizzle-kit';

try {
	process.loadEnvFile();
} catch {
	void 0;
}

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema/index.ts',
	out: './drizzle',
	casing: 'snake_case',
	dbCredentials: { url: process.env.OWNER_DATABASE_URL ?? '' },
	strict: true,
	verbose: false
});
