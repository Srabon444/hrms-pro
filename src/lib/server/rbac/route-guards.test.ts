import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODULE_IDS, MODULES } from '../../modules';

const files = globSync('src/routes/t/**/{+page.server.ts,+layout.server.ts,+server.ts}');
const guard = /\brequire(Perm|Member|Module)\(/g;
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

describe('module routes check the module is on in every handler', () => {
	const routed = MODULE_IDS.flatMap((m) => MODULES[m].routes.map((r) => [m, r] as const));

	it.each(routed)('%s owns /%s', (module, route) => {
		const owned = files.filter((f) => f.includes(`/t/[slug]/${route}/`));
		expect(owned.length).toBeGreaterThan(0);
		for (const file of owned) {
			const src = readFileSync(file, 'utf8');
			const handlers = src.match(handler)?.length ?? 0;
			expect(src.match(/\brequireModule\(/g)?.length ?? 0, file).toBeGreaterThanOrEqual(handlers);
		}
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

describe('routes outside tenants and the sign-in pages are allowlisted', () => {
	const PUBLIC: Record<string, string> = {
		'src/routes/api/v1/[...path]/+server.ts': 'src/lib/server/public/api.ts',
		'src/routes/api/scim/v2/[...path]/+server.ts': 'src/lib/server/public/scim.ts',
		'src/routes/ical/[file]/+server.ts': 'src/lib/server/public/ical.ts',
		'src/routes/kiosk/+page.server.ts': 'src/lib/server/public/kiosk.ts',
		'src/routes/kiosk/pair/+page.server.ts': 'src/lib/server/public/kiosk.ts',
		'src/routes/sign/[token]/+page.server.ts': 'src/lib/server/public/esign.ts',
		'src/routes/sign/[token]/document/+server.ts': 'src/lib/server/public/esign.ts'
	};
	const ANONYMOUS: Record<string, string> = {
		'src/routes/careers/[tenant]/+page.server.ts': 'src/lib/server/public/careers.ts',
		'src/routes/careers/[tenant]/[job]/+page.server.ts': 'src/lib/server/public/careers.ts'
	};
	const OTHER = [
		'src/routes/+page.server.ts',
		'src/routes/account/security/+page.server.ts',
		'src/routes/api/test/fixture/+server.ts',
		'src/routes/healthz/+server.ts',
		'src/routes/logout/+page.server.ts',
		'src/routes/metrics/+server.ts',
		'src/routes/platform/+layout.server.ts',
		'src/routes/platform/+page.server.ts',
		'src/routes/readyz/+server.ts',
		'src/routes/sso/callback/+server.ts',
		'src/routes/sso/start/+server.ts'
	];
	const outside = globSync('src/routes/**/{+page.server.ts,+layout.server.ts,+server.ts}').filter(
		(f) => !f.startsWith('src/routes/t/') && !f.startsWith('src/routes/(public)/')
	);

	it('lists every such route', () => {
		expect(outside.sort()).toEqual([...Object.keys(PUBLIC), ...Object.keys(ANONYMOUS), ...OTHER].sort());
	});

	it.each(Object.entries(PUBLIC))('%s goes through a rate limit and a token gate', (route, handler) => {
		const src = readFileSync(route, 'utf8');
		expect(src).toMatch(/from '#lib\/server\/public\//);
		expect(src).not.toMatch(/#lib\/server\/(?!public\/)/);
		const body = readFileSync(handler, 'utf8');
		expect(body).toMatch(/\b(hit|hitOrLocal)\(/);
		expect(body).toMatch(/\boverLimit\(/);
		expect(body).toMatch(/\blookupToken\(/);
		expect(body).toMatch(/\b(activeHolder|activeTenant)\(/);
	});

	it.each(Object.entries(ANONYMOUS))('%s goes through a rate limit and the tenant module gate', (route, handler) => {
		const src = readFileSync(route, 'utf8');
		expect(src).toMatch(/from '#lib\/server\/public\//);
		expect(src).not.toMatch(/#lib\/server\/(?!public\/)/);
		const body = readFileSync(handler, 'utf8');
		expect(body).toMatch(/\bhitOrLocal\(/);
		expect(body).toMatch(/\boverLimit\(/);
		expect(body).toMatch(/\.has\('careers'\)/);
		expect(body).toMatch(/status !== 'active'/);
	});
});
