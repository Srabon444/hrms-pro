import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR adds a night shift and assigns it to an employee', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Shifts', exact: true }).click();
	const add = page.getByRole('region', { name: 'New shift' });
	await add.getByLabel('Name').fill('Night');
	await add.getByLabel('Starts').fill('22:00');
	await add.getByLabel(/^Ends/).fill('06:00');
	await add.getByLabel('Minutes for a full day').fill('420');
	await add.getByRole('button', { name: 'Add shift' }).click();
	await expect(page.getByRole('status')).toHaveText('Shifts saved.');
	await expect(page.getByRole('region', { name: 'Night' }).getByRole('heading')).toContainText('22:00–06:00');

	await page.goto(`/t/${slug}/employees/${f.users.ela.employeeId}`);
	const shift = page.getByRole('region', { name: 'Shift' });
	await expect(shift.getByTestId('current-shift')).toHaveText('General · 09:00–18:00');
	await shift.getByRole('combobox').selectOption({ label: 'Night' });
	await shift.getByLabel('Starting').fill('2026-01-05');
	await shift.getByRole('button', { name: 'Assign shift' }).click();
	await expect(page.getByRole('status')).toHaveText('Shift saved.');
	await expect(shift.getByTestId('current-shift')).toHaveText('Night · 22:00–06:00');
	await expect(shift.getByTestId('shift-assignment')).toHaveText([/From 2026-01-05: Night/]);
	await shift.getByRole('button', { name: 'Remove shift from 2026-01-05' }).click();
	await expect(shift.getByTestId('current-shift')).toHaveText('General · 09:00–18:00');
});
