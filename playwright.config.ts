import { defineConfig, devices } from '@playwright/test';
import { E2E_URL, e2eEnv } from './tests/e2e/env';

export default defineConfig({
	testDir: 'tests/e2e',
	globalSetup: './tests/e2e/global-setup.ts',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	use: { baseURL: E2E_URL, trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'npm run build && node build',
		url: `${E2E_URL}/healthz`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		env: { ...(process.env as Record<string, string>), ...e2eEnv }
	}
});
