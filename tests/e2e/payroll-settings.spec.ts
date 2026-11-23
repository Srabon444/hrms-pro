import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an admin sets provident fund and overtime pay rules', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'adm', roles: ['hr_admin'] }] });
	await signIn(page, f.users.adm.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Payroll settings', exact: true }).click();
	await page.getByLabel('Part-month pay is based on').selectOption('working');
	await page.getByLabel('Provident fund, employee (% of basic)').fill('10');
	await page.getByLabel('Provident fund, employer (% of basic)').fill('10');
	await page.getByLabel('Overtime rate (% of hourly basic, 0 = unpaid)').fill('200');
	await page.getByRole('button', { name: 'Save payroll settings' }).click();
	await expect(page.getByRole('status')).toHaveText('Payroll settings saved.');
	await page.reload();
	await expect(page.getByLabel('Provident fund, employee (% of basic)')).toHaveValue('10.00');
	await expect(page.getByLabel('Overtime rate (% of hourly basic, 0 = unpaid)')).toHaveValue('200.00');
	await expect(page.getByLabel('Part-month pay is based on')).toHaveValue('working');
});
