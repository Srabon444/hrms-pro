import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR gives one person a Saturday–Sunday weekend on a phone', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	const start = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
	await page.setViewportSize({ width: 390, height: 800 });
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${slug}/settings`);
	await page.getByRole('link', { name: 'Work weeks', exact: true }).click();
	const add = page.getByRole('region', { name: 'New work week' });
	await add.getByLabel('Name').fill('Saturday and Sunday off for the weekend support desk team');
	await add.getByLabel('Saturday').check();
	await add.getByLabel('Sunday').check();
	await add.getByRole('button', { name: 'Add work week' }).click();
	await expect(page.getByRole('status')).toHaveText('Work weeks saved.');
	const name = 'Saturday and Sunday off for the weekend support desk team';
	await expect(page.getByRole('region', { name }).getByRole('heading')).toContainText('Weekend: Sunday, Saturday');
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

	await page.goto(`/t/${slug}/employees/${f.users.ela.employeeId}`);
	const ww = page.getByRole('region', { name: 'Work week' });
	await expect(ww.getByTestId('current-work-week')).toContainText('Company weekend');
	await ww.getByRole('combobox').selectOption({ label: name });
	await ww.getByLabel('Starting').fill(start);
	await ww.getByRole('button', { name: 'Assign work week' }).click();
	await expect(page.getByRole('status')).toHaveText('Work week saved.');
	await expect(ww.getByTestId('work-week-assignment')).toHaveText([
		new RegExp(`From ${start}: ${name} \\(Sunday, Saturday\\)`)
	]);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

	await page.goto(`/t/${slug}/settings/work-weeks`);
	const used = page.getByRole('region', { name });
	await expect(used.getByText('People follow this work week, so its days are fixed.')).toBeVisible();
	await expect(used.getByLabel('Monday')).toBeDisabled();
	await used.getByLabel('Name').fill('Weekend desk');
	await used.getByRole('button', { name: /^Save/ }).click();
	await expect(page.getByRole('status')).toHaveText('Work weeks saved.');
	await expect(page.getByRole('region', { name: 'Weekend desk' }).getByRole('heading')).toContainText(
		'Weekend: Sunday, Saturday'
	);

	await page.goto(`/t/${slug}/employees/${f.users.ela.employeeId}`);
	await ww.getByRole('button', { name: `Remove work week from ${start}` }).click();
	await expect(page.getByRole('status')).toHaveText('Work week saved.');
	await expect(ww.getByTestId('work-week-assignment')).toHaveCount(0);
});
