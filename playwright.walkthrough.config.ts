import { defineConfig, devices } from '@playwright/test';

const size = { width: 1440, height: 900 };

export default defineConfig({
	testDir: 'tests/walkthrough',
	outputDir: 'test-results/walkthrough',
	timeout: 30 * 60_000,
	reporter: 'list',
	use: {
		...devices['Desktop Chrome'],
		baseURL: process.env.WALK_URL ?? 'http://localhost:4174',
		actionTimeout: 15_000,
		navigationTimeout: 15_000,
		viewport: size,
		video: { mode: 'on', size },
		launchOptions: { slowMo: Number(process.env.WALK_SLOWMO ?? 350) }
	}
});
