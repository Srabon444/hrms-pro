import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('the home page shows each person the cards their role needs', async ({ page, browser }) => {
	const f = await fixture(page.request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'] },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.hr.email);
	await expect(page).toHaveURL(/\/t\//);
	await page.goto(`/t/${slug}`);
	await expect(page.getByRole('region', { name: 'Headcount this month' })).toBeVisible();
	await expect(page.getByTestId('headcount')).toContainText('Now');
	await expect(page.getByRole('region', { name: 'Leave balance' })).toHaveCount(0);

	const ctx = await browser.newContext();
	const ela = await ctx.newPage();
	await signIn(ela, f.users.ela.email);
	await expect(ela).toHaveURL(/\/t\//);
	await ela.goto(`/t/${slug}`);
	await expect(ela.getByRole('region', { name: 'Leave balance' })).toBeVisible();
	await expect(ela.getByRole('region', { name: 'Today', exact: true })).toContainText('You have not clocked in today.');
	await expect(ela.getByRole('region', { name: 'Headcount this month' })).toHaveCount(0);
	await expect(ela.getByRole('region', { name: 'Last payroll run' })).toHaveCount(0);
	await ctx.close();
});
