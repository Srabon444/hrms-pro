import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test.use({ viewport: { width: 390, height: 844 } });

test('an owner turns AI on, tests the platform key, saves an own key and removes it', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'staff', roles: ['employee'], employee: true }
		]
	});
	const t = `/t/${f.tenant!.slug}`;

	await signIn(page, f.users.staff.email);
	expect((await page.goto(`${t}/settings/ai`))?.status()).toBe(403);
	await page.context().clearCookies();

	await signIn(page, f.users.own.email);
	await page.goto(`${t}/settings`);
	await page.getByRole('link', { name: 'AI', exact: true }).click();
	await expect(page).toHaveURL(`${t}/settings/ai`);
	await expect(page.getByText(/uses the platform Gemini key/)).toBeVisible();

	await page.getByLabel('Turn AI on for this company').check();
	await page.getByRole('button', { name: 'Save AI settings' }).click();
	await expect(page.getByRole('alert')).toHaveText(/Confirm that company data may be sent/);

	await page.getByLabel('Turn AI on for this company').check();
	await page.getByLabel(/text and files a feature needs are sent/).check();
	await page.getByRole('button', { name: 'Save AI settings' }).click();
	await expect(page.getByText('AI settings saved.')).toBeVisible();
	await expect(page.getByLabel(/text and files a feature needs are sent/)).toHaveCount(0);

	await page.getByRole('button', { name: 'Test connection' }).click();
	await expect(page.getByText('Connection works. gemini-4-neon answered on the platform key.')).toBeVisible();

	await page.getByLabel('Provider').selectOption('openai');
	await page.getByLabel('New API key').fill('bad-e2e-key-0001');
	await page.getByRole('button', { name: 'Save AI settings' }).click();
	await expect(page.getByRole('alert')).toHaveText('The provider did not accept this API key.');
	expect(await page.content()).not.toContain('bad-e2e-key-0001');

	await page.getByLabel('Provider').selectOption('openai');
	await page.getByLabel('New API key').fill('good-e2e-key-7788');
	await page.getByRole('button', { name: 'Save AI settings' }).click();
	await expect(page.getByText('AI settings saved.')).toBeVisible();
	await expect(page.getByText(/Your OpenAI key ending …7788 is in use/)).toBeVisible();
	expect(await page.content()).not.toContain('good-e2e-key-7788');
	await expect(page.getByLabel('New API key')).toHaveValue('');

	await page.getByLabel('Model').selectOption('gpt-6.1-sol');
	await page.getByRole('button', { name: 'Save AI settings' }).click();
	await expect(page.getByText('AI settings saved.')).toBeVisible();
	await expect(page.getByLabel('Model')).toHaveValue('gpt-6.1-sol');
	await page.getByRole('button', { name: 'Test connection' }).click();
	await expect(page.getByText(/Connection works\. gpt-6\.2-sol answered\./)).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Connection tests' })).toBeVisible();

	await page.getByRole('button', { name: 'Remove key' }).click();
	await expect(page.getByText('API key removed.')).toBeVisible();
	await expect(page.getByText(/uses the platform Gemini key/)).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
