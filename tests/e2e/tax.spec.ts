import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an admin confirms tax rules and payroll records a tax profile', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'adm', roles: ['hr_admin'] },
			{ key: 'po', roles: ['payroll_officer'] },
			{ key: 'ana', roles: ['employee'], employee: true }
		]
	});
	await signIn(page, f.users.adm.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Settings', exact: true }).click();
	await page.getByRole('link', { name: 'Income tax', exact: true }).click();
	await page.getByRole('button', { name: 'Set up tax year' }).click();
	await expect(page.getByRole('status')).toContainText('set up. Review and confirm it.');
	await expect(page.getByTestId('tax-unconfirmed')).toBeVisible();

	const rules = page.getByRole('region', { name: 'Tax rules' });
	await rules.getByLabel('Minimum tax (৳)').fill('3000');
	await rules.getByLabel('General bands').fill('300000 0\nrest 10');
	await rules.getByRole('button', { name: 'Save rules' }).click();
	await expect(page.getByRole('status')).toHaveText('Tax rules saved. Confirm them before payroll runs.');
	await expect(rules.getByLabel('Minimum tax (৳)')).toHaveValue('3000.00');
	await expect(rules.getByLabel('General bands')).toHaveValue('300000 0\nrest 10');

	await rules.getByLabel('General bands').fill('300000 0');
	await rules.getByRole('button', { name: 'Save rules' }).click();
	await expect(page.getByRole('alert')).toBeVisible();

	await page.reload();
	await page.getByRole('button', { name: /^Confirm rules for / }).click();
	await expect(page.getByRole('status')).toHaveText('Tax rules confirmed.');
	await expect(page.getByTestId('tax-unconfirmed')).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Tax profiles' })).toHaveCount(0);

	await page.context().clearCookies();
	await signIn(page, f.users.po.email);
	await page.goto(`/t/${f.tenant!.slug}/settings/tax`);
	await expect(page.getByRole('button', { name: 'Save rules' })).toHaveCount(0);
	const row = page.getByTestId('tax-profile').filter({ hasText: 'ana' });
	await row.getByLabel(/^Tax category of ana/).selectOption('female_senior');
	await row.getByLabel(/^Investment rebate for ana/).fill('12000.50');
	await row.getByRole('button', { name: /^Save tax profile of ana/ }).click();
	await expect(page.getByRole('status')).toHaveText('Tax profile saved.');
	await expect(row.getByLabel(/^Investment rebate for ana/)).toHaveValue('12000.50');
	await expect(row.getByLabel(/^Tax category of ana/)).toHaveValue('female_senior');
});
