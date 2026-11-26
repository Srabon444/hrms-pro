import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hashPassword } from './lib/server/auth/password';
import { createUser, findUserByEmail } from './lib/server/auth/users';
import { authPool, closePools } from './lib/server/db';
import { migrateDatabase } from './lib/server/db/migrate';
import { tenants, users } from './lib/server/db/schema';
import { inviteLink } from './lib/server/invitations';
import { log } from './lib/server/log';
import { DEMO_LOCALE, seedDemo } from './lib/server/demo-seed';
import { provisionTenant, seedTenant, syncSystemRoles } from './lib/server/platform/tenants';
import { closeQueues } from './lib/server/queue';
import { closeRedis } from './lib/server/redis';
import { NEUTRAL_LOCALE } from './lib/server/settings';
import { ensureBucket } from './lib/server/storage';
import { systemCtx, withTenant } from './lib/server/tenancy';

try {
	process.loadEnvFile();
} catch {
	void 0;
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) throw new Error('pipe the password on stdin, e.g. printf %s "$PW" | npm run cli -- ...');
	let data = '';
	for await (const chunk of process.stdin) data += chunk;
	return data.replace(/\r?\n$/, '');
}

async function ensureUser(
	email: string,
	name: string,
	password: string,
	opts: { isPlatformAdmin?: boolean; resetPassword?: boolean } = {}
): Promise<string> {
	const existing = await findUserByEmail(email);
	if (!existing) return createUser({ email, name, password, isPlatformAdmin: opts.isPlatformAdmin });
	const patch = {
		...(opts.isPlatformAdmin ? { isPlatformAdmin: true } : {}),
		...(opts.resetPassword ? { passwordHash: await hashPassword(password), name } : {})
	};
	if (Object.keys(patch).length) await authPool().db.update(users).set(patch).where(eq(users.id, existing.id));
	return existing.id;
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
	async migrate() {
		await migrateDatabase();
		await ensureBucket();
		for (const t of await authPool().db.select({ id: tenants.id, slug: tenants.slug }).from(tenants)) {
			const changed = await withTenant(systemCtx(t.id), (tx) => syncSystemRoles(tx, t.id));
			if (changed.added || changed.removed) log.info({ tenant: t.slug, ...changed }, 'system roles synced');
		}
		log.info('migrations applied');
	},

	async 'create-platform-admin'([email, ...name]) {
		if (!email) throw new Error('usage: create-platform-admin <email> [name]');
		const id = await ensureUser(email, name.join(' ') || email, await readStdin(), { isPlatformAdmin: true });
		console.error(`platform admin ready: ${email} (${id})`);
	},

	async 'create-tenant'(args) {
		const [slug, name, ownerEmail] = args.filter((a) => !a.startsWith('--'));
		if (!slug || !name || !ownerEmail)
			throw new Error(
				'usage: create-tenant <slug> <name> <owner-email> [--timezone=UTC] [--currency=USD] [--fiscal-start=1] [--weekend=0,6]'
			);
		const option = (key: string) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);
		const locale = {
			timezone: option('timezone') ?? NEUTRAL_LOCALE.timezone,
			currency: option('currency') ?? NEUTRAL_LOCALE.currency,
			fiscalYearStartMonth: option('fiscal-start') ?? NEUTRAL_LOCALE.fiscalYearStartMonth,
			weekendDays: option('weekend')?.split(',').filter(Boolean) ?? NEUTRAL_LOCALE.weekendDays
		};
		const t = await provisionTenant({ slug, name, ownerEmail, locale }, null);
		console.error(`tenant ${t.slug} created; owner invitation: ${inviteLink(t.invitationToken)}`);
	},

	async seed() {
		if (process.env.NODE_ENV === 'production') throw new Error('seed refuses to run with NODE_ENV=production');
		process.env.TEST_MODE = '1';
		const password = process.env.SEED_PASSWORD || randomBytes(12).toString('base64url');
		await ensureUser('admin@hrms.local', 'Platform Admin', password, { isPlatformAdmin: true, resetPassword: true });
		const name = 'Nimbus Labs Ltd';
		let [tenant] = await authPool().db.select().from(tenants).where(eq(tenants.slug, 'demo'));
		if (!tenant) [tenant] = await authPool().db.insert(tenants).values({ slug: 'demo', name }).returning();
		await authPool().db.update(tenants).set({ name }).where(eq(tenants.id, tenant.id));
		await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id, DEMO_LOCALE));
		await seedDemo({ id: tenant.id, slug: tenant.slug, name }, password, ensureUser);
		console.error(
			`seeded tenant /t/demo (${name}); users admin@hrms.local, owner@demo.local, hr@demo.local, finance@demo.local, payroll@demo.local, manager@demo.local, staff@demo.local; password: ${process.env.SEED_PASSWORD ? '(SEED_PASSWORD)' : password}`
		);
	}
};

const [name, ...args] = process.argv.slice(2);
const command = name ? commands[name] : undefined;

if (!command) {
	console.error(`usage: cli <${Object.keys(commands).join('|')}>`);
	process.exit(2);
}

try {
	await command(args);
} catch (err) {
	log.error({ err }, `${name} failed`);
	process.exitCode = 1;
} finally {
	await Promise.all([closePools(), closeRedis(), closeQueues()]);
}
