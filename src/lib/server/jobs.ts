import type { Processor } from 'bullmq';
import { runAttendance } from './attendance';
import { runLifecycle } from './exits';
import { runLeaveAccrual } from './leave';
import { runCelebrations } from './directory';
import { runEventReminders } from './events';
import { deliverMail, type Mail } from './mail';
import { sendMealBill, sweepMealBills, type BillJob } from './meal-bills';
import { runMeals } from './meal-orders';
import { purgeCandidates } from './recruitment';
import { withPayslip } from './payslip-mail';
import { expireSwaps } from './shift-swaps';
import { runSteps } from './steps';
import type { QueueName } from './queue';

export const LIFECYCLE_STEPS: Record<string, () => Promise<unknown>> = {
	exits: runLifecycle,
	leaveAccrual: runLeaveAccrual,
	attendance: runAttendance,
	meals: runMeals,
	mealBills: sweepMealBills,
	candidates: purgeCandidates,
	celebrations: runCelebrations,
	eventReminders: runEventReminders,
	swaps: expireSwaps
};

export const processors: Record<QueueName, Processor> = {
	mail: async (job) => deliverMail(await withPayslip(job.data as Mail)),
	'meal-bills': (job) => sendMealBill(job.data as BillJob),
	lifecycle: () => runSteps(LIFECYCLE_STEPS)
};
