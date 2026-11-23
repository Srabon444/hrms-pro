import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR builds an onboarding checklist from the settings', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Checklists' }).click();
	await page.getByLabel('Type').selectOption('onboarding');
	await page.getByLabel('Checklist name').fill('New joiner');
	await page.getByRole('button', { name: 'Create checklist' }).click();
	await expect(page.getByRole('status')).toHaveText('Checklists saved.');

	const list = page.getByRole('region', { name: 'New joiner' });
	await list.getByLabel('Task').fill('Issue laptop');
	await list.getByLabel('Done by').selectOption('it_asset_manager');
	await list.getByLabel(/Due/).fill('-2');
	await list.getByRole('button', { name: 'Add task' }).click();
	await expect(list.getByTestId('template-item')).toHaveText(/Issue laptop · .* · 2 days before the join date/);
	await list.getByRole('button', { name: 'Remove Issue laptop' }).click();
	await expect(list.getByTestId('template-item')).toHaveCount(0);
	await list.getByRole('button', { name: 'Deactivate' }).click();
	await expect(list).toContainText('inactive');
});
