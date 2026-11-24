import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an owner switches the currency and money labels follow it', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'own', roles: ['owner'], employee: true }] });
	const t = `/t/${f.tenant!.slug}`;
	await signIn(page, f.users.own.email);
	await page.goto(`${t}/payroll/salaries`);
	const offer = page.getByRole('region', { name: 'New salary' });
	await expect(offer.getByLabel('Basic (৳)')).toBeVisible();

	await page.goto(`${t}/settings/organisation`);
	await page.getByLabel('Currency').selectOption('USD');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await expect(page.getByRole('status')).toHaveText('Settings saved.');
	await expect(page.getByLabel('Currency')).toHaveValue('USD');

	await page.goto(`${t}/payroll/salaries`);
	await expect(offer.getByLabel('Basic ($)')).toBeVisible();
	await page.goto(`${t}/loans`);
	await expect(page.getByLabel('Amount ($)')).toBeVisible();
});
