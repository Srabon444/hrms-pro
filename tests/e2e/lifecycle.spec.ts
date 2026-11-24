import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test('HR confirms one probation and extends another from the due list', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	for (const [name, ends] of [
		['Pia Probation', inDays(5)],
		['Ext Endless', inDays(20)]
	]) {
		await page.goto(`/t/${f.tenant!.slug}/employees/new`);
		await page.getByLabel('Full name').fill(name);
		await page.getByLabel('Status').selectOption('probation');
		await page.getByLabel('Join date').fill(inDays(-150));
		await page.getByLabel('Probation ends').fill(ends);
		await page.getByRole('button', { name: 'Add employee' }).click();
		await expect(page.getByRole('heading', { name })).toBeVisible();
	}

	await page.getByRole('link', { name: 'Lifecycle' }).click();
	const due = page.getByRole('region', { name: 'Probation due' });
	await expect(due.getByTestId('probation-row')).toHaveCount(2);
	await due.getByRole('listitem').filter({ hasText: 'Pia Probation' }).getByRole('button', { name: 'Confirm' }).click();
	await expect(page.getByRole('status')).toHaveText('Employment confirmed.');
	await expect(due.getByTestId('probation-row')).toHaveCount(1);

	await due.getByLabel('Extend Ext Endless to').fill(inDays(60));
	await due.getByRole('button', { name: 'Extend' }).click();
	await expect(page.getByRole('status')).toHaveText('Probation extended.');
	await expect(due.getByTestId('probation-row')).toHaveCount(0);

	await page.getByRole('link', { name: 'Employees' }).click();
	await page.getByRole('link', { name: 'Pia Probation' }).click();
	await expect(page.getByTestId('fact-Status')).toHaveText('active');
	await expect(page.getByTestId('history')).toContainText('Status: probation → active');
});
