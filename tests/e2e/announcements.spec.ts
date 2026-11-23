import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR publishes announcements and employees see only the live ones on their home page', async ({
	page,
	browser,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'] },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Announcements', exact: true }).click();
	const create = page.getByRole('region', { name: 'New announcement' });
	await create.getByLabel('Title').fill('Office closed Friday');
	await create.getByLabel('Message').fill('Enjoy the long weekend.');
	await create.getByLabel('Pin to the top').check();
	await create.getByRole('button', { name: 'Publish' }).click();
	await create.getByLabel('Title').fill('Next year plan');
	await create.getByLabel('Message').fill('Coming soon.');
	await create.getByLabel('Publish on').fill('2099-01-01');
	await create.getByRole('button', { name: 'Publish' }).click();
	await expect(page.getByTestId('announcement-row')).toHaveText([
		/Next year plan\s*Everyone\s*2099-01-01\s*—\s*Scheduled/,
		/📌 Office closed Friday\s*Everyone.*Live/
	]);
	await page.getByRole('link', { name: 'Next year plan' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Next year plan');
	await page.getByLabel('Title').fill('Plan for 2099');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByTestId('announcement-row').first()).toContainText('Plan for 2099');

	const ctx = await browser.newContext();
	const ela = await ctx.newPage();
	await signIn(ela, f.users.ela.email);
	await expect(ela).toHaveURL(/\/t\//);
	await ela.goto(`/t/${slug}`);
	await expect(ela.getByTestId('announcement')).toHaveText([/📌 Office closed Friday.*Enjoy the long weekend\./s]);
	await ela.getByRole('link', { name: 'See all' }).click();
	await expect(ela.getByRole('region', { name: 'New announcement' })).toHaveCount(0);
	await expect(ela.getByTestId('announcement')).toHaveCount(1);
	await ctx.close();

	await page.getByRole('link', { name: '📌 Office closed Friday' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Office closed Friday');
	await page.getByRole('button', { name: 'Delete announcement' }).click();
	await expect(page.getByTestId('announcement-row')).toHaveCount(1);
});
