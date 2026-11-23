import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an admin sets provident fund, overtime and festival bonus pay rules', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'adm', roles: ['hr_admin'] }] });
	await signIn(page, f.users.adm.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Payroll settings', exact: true }).click();
	await page.getByLabel('Part-month pay is based on').selectOption('working');
	await page.getByLabel('Provident fund, employee (% of basic)').fill('10');
	await page.getByLabel('Provident fund, employer (% of basic)').fill('10');
	await page.getByLabel('Overtime rate (% of hourly basic, 0 = unpaid)').fill('200');
	await page.getByLabel('Festival bonus (% of basic)').fill('50');
	await page.getByLabel('Months of service before a festival bonus').fill('6');
	await page.getByLabel('Months that salary arrears look back').fill('3');
	await page.getByRole('button', { name: 'Save payroll settings' }).click();
	await expect(page.getByRole('status')).toHaveText('Payroll settings saved.');
	await page.reload();
	await expect(page.getByLabel('Provident fund, employee (% of basic)')).toHaveValue('10.00');
	await expect(page.getByLabel('Overtime rate (% of hourly basic, 0 = unpaid)')).toHaveValue('200.00');
	await expect(page.getByLabel('Part-month pay is based on')).toHaveValue('working');
	await expect(page.getByLabel('Festival bonus (% of basic)')).toHaveValue('50.00');
	await expect(page.getByLabel('Months of service before a festival bonus')).toHaveValue('6');
	await expect(page.getByLabel('Months that salary arrears look back')).toHaveValue('3');
});
