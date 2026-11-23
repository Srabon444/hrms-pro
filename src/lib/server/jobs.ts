import type { Processor } from 'bullmq';
import { runLifecycle } from './exits';
import { runLeaveAccrual } from './leave';
import { deliverMail, type Mail } from './mail';
import type { QueueName } from './queue';

export const processors: Record<QueueName, Processor> = {
	mail: (job) => deliverMail(job.data as Mail),
	lifecycle: async () => {
		await runLifecycle();
		await runLeaveAccrual();
	}
};
