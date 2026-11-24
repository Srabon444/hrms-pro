import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = globSync('src/routes/t/**/{+page.server.ts,+layout.server.ts,+server.ts}');
const guard = /\brequire(Perm|Member)\(/g;
const handler = /^\s*(?:export const (?:load|GET|POST|PUT|PATCH|DELETE)\b|\w+: async\b)/gm;

describe('tenant routes check access in every handler', () => {
	it('finds tenant route files', () => {
		expect(files.length).toBeGreaterThan(5);
	});

	it.each(files)('%s', (file) => {
		const src = readFileSync(file, 'utf8');
		const handlers = src.match(handler)?.length ?? 0;
		expect(handlers).toBeGreaterThan(0);
		expect(src.match(guard)?.length ?? 0).toBeGreaterThanOrEqual(handlers);
	});
});

describe('browser code never imports server modules', () => {
	const clientFiles = globSync('src/{routes,lib}/**/*.{svelte,svelte.ts}').concat(
		globSync('src/routes/**/{+page,+layout}.ts')
	);

	it.each(clientFiles)('%s', (file) => {
		expect(readFileSync(file, 'utf8')).not.toMatch(/from\s+['"][^'"]*\/server\//);
	});
});
