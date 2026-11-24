import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR builds an onboarding checklist from the settings', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Settings', exact: true }).click();
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

test('a joiner gets the checklist, each assignee ticks off their task and HR tracks it', async ({
	page,
	browser,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'] },
			{ key: 'it', roles: ['it_asset_manager'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${slug}/settings/checklists`);
	await page.getByLabel('Type').selectOption('onboarding');
	await page.getByLabel('Checklist name').fill('New joiner');
	await page.getByRole('button', { name: 'Create checklist' }).click();
	const list = page.getByRole('region', { name: 'New joiner' });
	for (const [task, role] of [
		['Issue laptop', 'it_asset_manager'],
		['Welcome lunch', 'hr_admin']
	]) {
		await list.getByLabel('Task').fill(task);
		await list.getByLabel('Done by').selectOption(role);
		await list.getByLabel(/Due/).fill('0');
		await list.getByRole('button', { name: 'Add task' }).click();
		await expect(list.getByTestId('template-item').filter({ hasText: task })).toBeVisible();
	}

	await page.goto(`/t/${slug}/employees/new`);
	await page.getByLabel('Full name').fill('Nia New');
	await page.getByLabel('Status').selectOption('onboarding');
	await page.getByLabel('Join date').fill(new Date().toISOString().slice(0, 10));
	await page.getByRole('button', { name: 'Add employee' }).click();
	await expect(page.getByRole('heading', { name: 'Nia New' })).toBeVisible();
	const profile = page.url();
	await expect(page.getByRole('region', { name: 'Checklists' }).getByTestId('checklist-item')).toHaveCount(2);

	await page.getByRole('link', { name: 'Lifecycle' }).click();
	const tasks = page.getByRole('region', { name: 'Checklist tasks' });
	await expect(tasks.getByTestId('task')).toHaveCount(2);
	await tasks.getByRole('button', { name: 'Done: Welcome lunch for Nia New' }).click();
	await expect(page.getByRole('status')).toHaveText('Task done.');
	await expect(tasks.getByTestId('task')).toHaveCount(1);

	const ctx = await browser.newContext();
	const it = await ctx.newPage();
	await signIn(it, f.users.it.email);
	await it.goto(`/t/${slug}`);
	await it.getByRole('link', { name: 'Tasks' }).click();
	const mine = it.getByRole('region', { name: 'Open tasks' });
	await expect(mine.getByTestId('task')).toHaveText([/Issue laptop.*Nia New.*IT\/Asset Manager/s]);
	await mine.getByRole('button', { name: 'Done: Issue laptop for Nia New' }).click();
	await expect(it.getByRole('status')).toHaveText('Task done.');
	await expect(mine).toContainText('No open tasks.');
	await ctx.close();

	await page.goto(profile);
	const checklist = page.getByRole('region', { name: 'Checklists' });
	await checklist.getByRole('button', { name: 'Undo: Issue laptop' }).click();
	await expect(page.getByRole('status')).toHaveText('Checklist saved.');
	await expect(checklist.getByRole('button', { name: 'Done: Issue laptop' })).toBeVisible();
	await expect(checklist.getByRole('button', { name: 'Undo: Welcome lunch' })).toBeVisible();
});
