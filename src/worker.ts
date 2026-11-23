import { closePools } from './lib/server/db';
import { processors } from './lib/server/jobs';
import { log } from './lib/server/log';
import { closeQueues, startWorker, type QueueName } from './lib/server/queue';
import { closeRedis } from './lib/server/redis';

try {
	process.loadEnvFile();
} catch {
	void 0;
}

const workers = (Object.keys(processors) as QueueName[]).map((name) => startWorker(name, processors[name]));
await Promise.all(workers.map((w) => w.waitUntilReady()));
log.info({ queues: Object.keys(processors) }, 'worker ready');

async function shutdown(signal: string) {
	log.info({ signal }, 'worker stopping');
	await Promise.all(workers.map((w) => w.close()));
	await Promise.all([closeQueues(), closePools(), closeRedis()]);
	process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutdown(signal));
