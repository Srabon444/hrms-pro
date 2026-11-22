import { defineConfig } from 'vitest/config';
import { testEnv } from './tests/env.ts';

export default defineConfig({
	test: {
		projects: [
			{
				test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' }
			},
			{
				test: {
					name: 'integration',
					include: ['tests/integration/**/*.test.ts'],
					environment: 'node',
					env: testEnv('hrms_test'),
					globalSetup: ['tests/integration/global-setup.ts'],
					fileParallelism: false,
					testTimeout: 60_000,
					hookTimeout: 120_000
				}
			}
		]
	}
});
