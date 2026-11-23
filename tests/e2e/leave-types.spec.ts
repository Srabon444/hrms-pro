import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR tunes a seeded leave type and adds a new one', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Leave types' }).click();

	const casual = page.getByRole('region', { name: 'Casual leave' });
	await expect(casual.getByLabel(/Days per year/)).toHaveValue('10');
	await casual.getByLabel(/Days per year/).fill('12');
	await casual.getByLabel('Half days allowed').uncheck();
	await casual.getByRole('button', { name: 'Save Casual leave' }).click();
	await expect(page.getByRole('status')).toHaveText('Leave types saved.');
	await expect(casual.getByLabel(/Days per year/)).toHaveValue('12');
	await expect(casual.getByLabel('Half days allowed')).not.toBeChecked();

	const add = page.getByRole('region', { name: 'New leave type' });
	await add.getByLabel('Code').fill('study');
	await add.getByLabel('Name').fill('Study leave');
	await add.getByLabel(/Days per year/).fill('5');
	await add.getByRole('button', { name: 'Add leave type' }).click();
	await expect(page.getByRole('region', { name: 'Study leave' })).toContainText('study');

	await add.getByLabel('Code').fill('study_again');
	await add.getByLabel('Name').fill('Study leave');
	await add.getByRole('button', { name: 'Add leave type' }).click();
	await expect(page.getByRole('alert')).toHaveText('A leave type with that code or name already exists.');
});
