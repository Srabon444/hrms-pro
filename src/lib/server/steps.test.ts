import { describe, expect, it } from 'vitest';
import { lifecycleStepFailures } from './metrics';
import { runSteps } from './steps';

const failures = async (step: string) =>
	(await lifecycleStepFailures.get()).values.find((v) => v.labels.step === step)?.value ?? 0;

describe('runSteps', () => {
	it('runs every step even when an earlier one throws, then reports the failed ones', async () => {
		const ran: string[] = [];
		const before = await failures('broken');
		await expect(
			runSteps({
				first: async () => void ran.push('first'),
				broken: async () => {
					throw new Error('boom');
				},
				last: async () => void ran.push('last')
			})
		).rejects.toThrow('Lifecycle steps failed: broken');
		expect(ran).toEqual(['first', 'last']);
		expect(await failures('broken')).toBe(before + 1);
	});

	it('resolves when every step succeeds', async () => {
		await expect(runSteps({ only: async () => 1 })).resolves.toBeUndefined();
	});
});
