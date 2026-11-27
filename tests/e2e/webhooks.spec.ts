import { expect, test } from '@playwright/test';
import { fixture, PASSWORD, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };
const URL_OK = 'https://hooks.example.com/hrms';

test('the owner confirms their password, adds a webhook endpoint, turns it off and on and deletes it', async ({
	page,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [{ key: 'own', roles: ['owner'], employee: true }]
	});
	await page.setViewportSize(PHONE);
	await signIn(page, f.users.own.email);
	await page.goto(`/t/${f.tenant!.slug}/settings`);
	await page.getByRole('link', { name: 'Webhooks' }).first().click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Webhooks');

	const add = page.getByRole('region', { name: 'New endpoint' });
	await add.getByLabel('Your password').fill(PASSWORD);
	await add.getByRole('button', { name: 'Confirm' }).click();
	await expect(page.getByRole('status')).toHaveText(/^Confirmed\./);

	await add.getByLabel('Address').fill('https://10.0.0.5/hook');
	await add.getByRole('button', { name: 'Add endpoint' }).click();
	await expect(page.getByRole('alert')).toHaveText('The address must be on the public internet.');

	await add.getByLabel('Address').fill(URL_OK);
	await add.getByLabel('Employee changed').uncheck();
	await add.getByRole('button', { name: 'Add endpoint' }).click();
	const secret = await page.getByRole('region', { name: 'Signing secret' }).getByLabel('Signing secret').inputValue();
	expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
	const card = page.getByRole('region', { name: URL_OK });
	await expect(card.getByTestId('webhook-state')).toHaveText(/^On · 0 failures in a row$/);
	await expect(card).not.toContainText('Employee changed');
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

	await card.getByRole('button', { name: 'Turn off' }).click();
	await expect(page.getByRole('status')).toHaveText('Endpoint turned off.');
	await expect(card.getByTestId('webhook-state')).toContainText(/^Off since/);
	await card.getByRole('button', { name: 'Turn on' }).click();
	await expect(page.getByRole('status')).toHaveText('Endpoint turned on.');

	await card.getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByRole('status')).toHaveText('Endpoint deleted.');
	await expect(page.getByRole('region', { name: URL_OK })).toHaveCount(0);
});
