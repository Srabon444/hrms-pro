import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR adds an employee, moves them and finds them in the list', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	await page.getByRole('link', { name: 'Organisation' }).click();
	const depts = page.getByRole('region', { name: 'Departments' });
	for (const name of ['Engineering', 'Sales']) {
		await depts.getByLabel('New department name').fill(name);
		await depts.getByRole('button', { name: 'Add' }).click();
		await expect(depts).toContainText(name);
	}

	await page.getByRole('link', { name: 'Employees' }).click();
	await page.getByRole('link', { name: 'New employee' }).click();
	await page.getByLabel('Full name').fill('Rahim Uddin');
	await page.getByLabel('Work email').fill('rahim@acme.test');
	await page.getByLabel('Department').selectOption({ label: 'Engineering' });
	await page.getByLabel('Join date').fill('2026-02-01');
	await page.getByLabel('National ID').fill('1987654321');
	await page.getByRole('button', { name: 'Add employee' }).click();

	await expect(page.getByRole('heading', { name: 'Rahim Uddin' })).toBeVisible();
	await expect(page.getByTestId('fact-Code')).toHaveText('EMP-0001');
	await expect(page.getByText('1987654321').first()).toBeVisible();

	await page.getByLabel('Department').selectOption({ label: 'Sales' });
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('status')).toHaveText('Employee saved.');
	await expect(page.getByTestId('fact-Department')).toHaveText('Sales');
	await expect(page.getByTestId('history')).toContainText('Engineering → Sales');

	await page.getByRole('link', { name: 'Back to employees' }).click();
	await page.getByLabel('Search').fill('rahim@');
	await page.getByRole('button', { name: 'Filter' }).click();
	await expect(page.getByTestId('employee-total')).toHaveText('1');
	await expect(page.getByRole('link', { name: 'Rahim Uddin' })).toBeVisible();
});

test('an employee sees only their own record and cannot edit it', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'staff', employee: true },
			{ key: 'peer', employee: true }
		]
	});
	await signIn(page, f.users.staff.email);
	await page.getByRole('link', { name: 'Employees' }).click();
	await expect(page.getByTestId('employee-total')).toHaveText('1');
	await expect(page.getByRole('link', { name: 'New employee' })).toHaveCount(0);
	await page.getByRole('link', { name: /^staff / }).click();
	await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
	expect((await page.goto(`/t/${f.tenant!.slug}/employees/${f.users.peer.employeeId}`))!.status()).toBe(404);
	expect((await page.goto(`/t/${f.tenant!.slug}/employees/new`))!.status()).toBe(403);
});
