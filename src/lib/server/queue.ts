import { Queue, Worker, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config';
import { log } from './log';

export type QueueName = 'mail' | 'lifecycle' | 'meal-bills' | 'file-text' | 'webhooks';

const queues = new Map<QueueName, Queue>();
let producer: Redis | undefined;

const prefix = () => `${config().REDIS_PREFIX}:bull`;

export function queue(name: QueueName): Queue {
	const existing = queues.get(name);
	if (existing) return existing;
	producer ??= new Redis(config().REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
	const created = new Queue(name, {
		connection: producer,
		prefix: prefix(),
		defaultJobOptions: {
			attempts: 5,
			backoff: { type: 'exponential', delay: 5000 },
			removeOnComplete: 1000,
			removeOnFail: 5000
		}
	});
	queues.set(name, created);
	return created;
}

export function startWorker<T>(name: QueueName, processor: Processor<T>, concurrency = 5): Worker<T> {
	const worker = new Worker<T>(name, processor, {
		connection: new Redis(config().REDIS_URL, { maxRetriesPerRequest: null }),
		prefix: prefix(),
		concurrency
	});
	worker.on('failed', (job, err) =>
		log.error({ queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed')
	);
	worker.on('error', (err) => log.warn({ queue: name, err: err.message }, 'worker error'));
	return worker;
}

export async function closeQueues(): Promise<void> {
	await Promise.all([...queues.values()].map((q) => q.close()));
	queues.clear();
	if (producer) await producer.quit().catch(() => producer?.disconnect());
	producer = undefined;
}
