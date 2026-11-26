import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('staff find colleagues in the directory and the org chart; birthdays are opt-in', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'boss', roles: ['employee'], employee: true },
			{ key: 'staff', roles: ['employee'], employee: true, manager: 'boss' }
		]
	});
	const t = `/t/${f.tenant!.slug}`;

	await signIn(page, f.users.staff.email);
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Directory' }).click();
	await expect(page).toHaveURL(`${t}/directory`);
	await expect(page.getByRole('cell', { name: /^boss / }).first()).toBeVisible();
	await expect(page.getByRole('link', { name: /^boss / })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /^staff / })).toBeVisible();
	await expect(page.getByLabel(/Show my birthday/)).toHaveCount(0);

	await page.getByRole('link', { name: 'Org chart' }).click();
	await page.getByRole('button', { name: 'Find me' }).click();
	await expect(page.locator(':focus')).toContainText(/staff /);
	await expect(page.locator('[aria-current="true"]')).toHaveText(/^staff /);
	await page.getByRole('button', { name: /^Hide the team of boss / }).click();
	await expect(page.locator('[aria-current="true"]')).toHaveCount(0);

	await page.context().clearCookies();
	await signIn(page, f.users.own.email);
	await page.goto(`${t}/settings/modules`);
	await page.getByLabel('Birthdays').check();
	await page.getByRole('button', { name: 'Save modules' }).click();
	await expect(page.getByText('Modules saved.')).toBeVisible();
	await page.goto(`${t}/directory`);
	await page.getByLabel(/Show my birthday/).check();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await expect(page.getByLabel(/Show my birthday/)).toBeChecked();

	await page.goto(`${t}/settings/modules`);
	await page.getByLabel('Directory and org chart').uncheck();
	await page.getByRole('button', { name: 'Save modules' }).click();
	await expect(page.getByText('Modules saved.')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Directory' })).toHaveCount(0);
	expect((await page.goto(`${t}/directory`))?.status()).toBe(404);
	expect((await page.request.get(`${t}/directory/chart/nodes?path=me`)).status()).toBe(404);
	const origin = new URL(page.url()).origin;
	expect((await page.request.post(`${t}/directory?/birthday`, { headers: { origin }, form: {} })).status()).toBe(404);
	await page.goto(`${t}/settings/modules`);
	await page.getByLabel('Directory and org chart').check();
	await page.getByRole('button', { name: 'Save modules' }).click();
	await expect(page.getByText('Modules saved.')).toBeVisible();
	await page.goto(`${t}/directory`);
	await expect(page.getByLabel(/Show my birthday/)).toBeChecked();
});
