import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR builds the department tree and holiday calendar', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	await page.getByRole('link', { name: 'Organisation' }).click();

	const depts = page.getByRole('region', { name: 'Departments' });
	await depts.getByLabel('New department name').fill('Engineering');
	await depts.getByRole('button', { name: 'Add' }).click();
	await depts.getByLabel('New department name').fill('Mobile');
	await depts.getByLabel('Parent of new department').selectOption({ label: 'Engineering' });
	await depts.getByRole('button', { name: 'Add' }).click();
	await expect(depts).toContainText('Under Engineering');

	await depts.getByLabel('Parent of Engineering').selectOption({ label: 'Mobile' });
	await depts.getByRole('button', { name: 'Save' }).first().click();
	await expect(page.getByRole('alert')).toHaveText('A department cannot sit under itself.');

	await depts.getByRole('button', { name: 'Delete Engineering' }).click();
	await expect(page.getByRole('alert')).toHaveText('That department is still in use.');

	const holidays = page.getByRole('region', { name: 'Holidays' });
	const year = await holidays.getByRole('heading').textContent();
	await holidays.getByLabel('Holiday date').fill(`${year!.slice(-4)}-12-16`);
	await holidays.getByLabel('Holiday name').fill('Victory Day');
	await holidays.getByRole('button', { name: 'Add holiday' }).click();
	await expect(holidays).toContainText('Victory Day');
});

test('settings reject invalid values and save valid ones', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'owner', roles: ['owner'] }] });
	await signIn(page, f.users.owner.email);
	await page.getByRole('link', { name: 'Settings', exact: true }).click();
	await page.getByRole('link', { name: 'General', exact: true }).click();
	await page.getByLabel('Thursday').check();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status')).toHaveText('Settings saved.');
	await page.reload();
	await expect(page.getByLabel('Thursday')).toBeChecked();

	await page
		.getByRole('navigation', { name: 'Settings' })
		.getByRole('link', { name: 'Security and retention' })
		.click();
	const audit = page.getByLabel('Keep audit history (days)');
	await expect(audit).toHaveAttribute('min', '365');
	await audit.evaluate((el: HTMLInputElement) => el.removeAttribute('min'));
	await audit.fill('10');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('alert')).toHaveText('Keep audit history: enter 365 to 3650 days.');
	await audit.fill('1000');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status')).toHaveText('Settings saved.');
	await page.reload();
	await expect(audit).toHaveValue('1000');
});
