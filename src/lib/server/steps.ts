import { log } from './log';
import { lifecycleStepFailures } from './metrics';

const attempt = (step: string, run: () => Promise<unknown>): Promise<string[]> =>
	run().then(
		() => [],
		(err) => {
			lifecycleStepFailures.inc({ step });
			log.error({ step, err: (err as Error).message }, 'lifecycle step failed');
			return [step];
		}
	);

export async function runSteps(steps: Record<string, () => Promise<unknown>>): Promise<void> {
	const failed = await Object.entries(steps).reduce<Promise<string[]>>(
		(prior, [step, run]) => prior.then(async (done) => done.concat(await attempt(step, run))),
		Promise.resolve([])
	);
	if (failed.length) throw new Error(`Lifecycle steps failed: ${failed.join(', ')}`);
}
