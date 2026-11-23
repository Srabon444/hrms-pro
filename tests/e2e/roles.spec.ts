import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('only role managers reach the role editor', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	await expect(page.getByRole('navigation', { name: 'Main' })).not.toContainText('Roles');
	expect((await page.goto(`/t/${f.tenant!.slug}/settings/roles`))?.status()).toBe(403);
});

test('the owner creates a role, grants a permission and assigns it to a member', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [{ key: 'owner', roles: ['owner'] }, { key: 'emp' }]
	});
	await signIn(page, f.users.owner.email);
	await page.getByRole('link', { name: 'Roles' }).click();

	await page.getByLabel('Role name').fill('Report viewer');
	await page.getByRole('button', { name: 'Create role' }).click();
	await expect(page.getByRole('heading', { name: 'Report viewer' })).toBeVisible();
	await page.getByLabel('report.headcount all').check();
	await page.getByRole('button', { name: 'Save role' }).click();
	await expect(page.getByRole('status')).toHaveText('Role saved.');
	await page.reload();
	await expect(page.getByLabel('report.headcount all')).toBeChecked();

	await page.getByRole('link', { name: 'Back to roles' }).click();
	await page.getByRole('link', { name: 'Employee', exact: true }).click();
	await expect(page.getByLabel('payroll.read all')).toBeDisabled();

	await page.getByRole('link', { name: 'Users' }).click();
	await page
		.getByRole('row', { name: new RegExp(f.users.emp.email) })
		.getByRole('link')
		.first()
		.click();
	await page.getByLabel('Report viewer').check();
	await page.getByRole('button', { name: 'Save roles' }).click();
	await expect(page.getByRole('status')).toHaveText('Roles updated.');
});
