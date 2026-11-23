import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('employees are refused the admin screens but have an approvals inbox', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'emp' }] });
	await signIn(page, f.users.emp.email);
	const nav = page.getByRole('navigation', { name: 'Main' });
	await expect(nav).not.toContainText('Audit log');
	for (const path of ['settings/users', 'settings/roles', 'settings/audit'])
		expect((await page.goto(`/t/${f.tenant!.slug}/${path}`))?.status(), path).toBe(403);
	await page.goto(`/t/${f.tenant!.slug}`);
	await nav.getByRole('link', { name: 'Approvals' }).click();
	await expect(page.getByText('Nothing is waiting for your decision.')).toBeVisible();
});

test('HR filters the audit log by record type', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	await page.getByRole('link', { name: 'Audit log' }).click();
	await page.getByLabel('Record type').selectOption('membership_roles');
	await page.getByRole('button', { name: 'Filter' }).click();
	await expect(page).toHaveURL(/table=membership_roles/);
	await expect(page.getByTestId('audit-entry').first()).toContainText('INSERT membership_roles');
});
