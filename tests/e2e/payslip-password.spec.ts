import { expect, test } from '@playwright/test';
import { fixture, PASSWORD, signIn } from './fixtures';

test('staff set a payslip PDF password on a phone and admins turn on emailed PDFs', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'adm', roles: ['hr_admin'] },
			{ key: 'ana', roles: ['employee'], employee: true }
		]
	});
	const t = `/t/${f.tenant!.slug}`;

	await signIn(page, f.users.adm.email);
	await page.goto(`${t}/settings/payroll`);
	const toggle = page.getByLabel('Attach the payslip PDF to the payslip email');
	await expect(toggle).not.toBeChecked();
	await toggle.check();
	await page.getByRole('button', { name: 'Save payroll settings' }).click();
	await expect(page.getByRole('status')).toHaveText('Payroll settings saved.');
	await page.reload();
	await expect(toggle).toBeChecked();
	await page.goto(`${t}/payslips`);
	await expect(page.getByRole('region', { name: 'Payslip PDF password' })).toHaveCount(0);

	await page.context().clearCookies();
	await page.setViewportSize({ width: 390, height: 800 });
	await signIn(page, f.users.ana.email);
	await page.goto(`${t}/payslips`);
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	const panel = page.getByRole('region', { name: 'Payslip PDF password' });
	await expect(panel).toContainText('your payslip email will carry the PDF');
	await expect(panel.getByTestId('pdf-password-state')).toHaveText('No payslip password yet.');
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

	await panel.getByLabel('New payslip password').fill(PASSWORD);
	await panel.getByLabel('Repeat it').fill(PASSWORD);
	await panel.getByRole('button', { name: 'Set password' }).click();
	await expect(panel.getByRole('alert')).toContainText('different from your sign-in password');

	await panel.getByLabel('New payslip password').fill('river lantern 42 maple');
	await panel.getByLabel('Repeat it').fill('river lantern 42 maple');
	await panel.getByRole('button', { name: 'Set password' }).click();
	await expect(panel.getByRole('status')).toHaveText('Payslip password saved.');
	await expect(panel.getByTestId('pdf-password-state')).toHaveText('A payslip password is set.');

	await panel.getByRole('button', { name: 'Remove password' }).click();
	await expect(panel.getByRole('status')).toHaveText('Payslip password removed.');
	await expect(panel.getByTestId('pdf-password-state')).toHaveText('No payslip password yet.');
	await expect(panel.getByRole('button', { name: 'Remove password' })).toHaveCount(0);
});
