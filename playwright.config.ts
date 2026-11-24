import { defineConfig, devices } from '@playwright/test';
import { E2E_URL, e2eEnv } from './tests/e2e/env';

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	use: { baseURL: E2E_URL, trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: [
		{
			command: 'npm run build && node build',
			url: `${E2E_URL}/healthz`,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
			env: { ...(process.env as Record<string, string>), ...e2eEnv }
		},
		{
			command: 'node --import tsx tests/e2e/prepare-db.ts && node --import tsx src/worker.ts',
			wait: { stdout: /worker ready/ },
			reuseExistingServer: !process.env.CI,
			timeout: 60_000,
			env: { ...(process.env as Record<string, string>), ...e2eEnv, LOG_LEVEL: 'info' }
		}
	]
});
