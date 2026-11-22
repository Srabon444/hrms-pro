import { closePools } from './lib/server/db';
import { migrateDatabase } from './lib/server/db/migrate';
import { ensureBucket } from './lib/server/storage';
import { closeRedis } from './lib/server/redis';
import { log } from './lib/server/log';

try {
	process.loadEnvFile();
} catch {
	void 0;
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
	async migrate() {
		await migrateDatabase();
		await ensureBucket();
		log.info('migrations applied');
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
	await closePools();
	await closeRedis();
}
