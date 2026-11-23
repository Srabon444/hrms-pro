import type { Processor } from 'bullmq';
import { runAttendance } from './attendance';
import { runLifecycle } from './exits';
import { runLeaveAccrual } from './leave';
import { deliverMail, type Mail } from './mail';
import { sendMealBill, sweepMealBills, type BillJob } from './meal-bills';
import { runMeals } from './meal-orders';
import type { QueueName } from './queue';

export const processors: Record<QueueName, Processor> = {
	mail: (job) => deliverMail(job.data as Mail),
	'meal-bills': (job) => sendMealBill(job.data as BillJob),
	lifecycle: async () => {
		await runLifecycle();
		await runLeaveAccrual();
		await runAttendance();
		await runMeals();
		await sweepMealBills();
	}
};
