import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('a project manager staffs a project, the employee logs and submits a week, their manager approves it', async ({
	page,
	browser,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'owner', roles: ['owner'] },
			{ key: 'boss', roles: ['line_manager'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true, manager: 'boss' }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.owner.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Projects', exact: true }).click();
	const create = page.getByRole('region', { name: 'New project' });
	await create.getByLabel('Code').fill('web-1');
	await create.getByLabel('Name').fill('Website');
	await create.getByLabel('Client').fill('Acme');
	await create.getByRole('button', { name: 'Create project' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('WEB-1 · Website');
	const staff = page.getByRole('region', { name: 'Add to team' });
	await staff.getByLabel('Employee').selectOption(f.users.ela.employeeId!);
	await staff.getByLabel('Allocation (%)').fill('80');
	await staff.getByRole('button', { name: 'Save member' }).click();
	await expect(page.getByRole('status')).toHaveText('Team updated.');
	await expect(page.getByTestId('project-member')).toHaveText([/ela .* · Member · 80%/]);

	const elaCtx = await browser.newContext();
	const ela = await elaCtx.newPage();
	await signIn(ela, f.users.ela.email);
	await expect(ela).toHaveURL(/\/t\//);
	await ela.goto(`/t/${slug}`);
	await ela.getByRole('link', { name: 'Timesheets', exact: true }).click();
	const logForm = ela.getByRole('region', { name: 'Log time' });
	await logForm.getByLabel('Hours').fill('7.5');
	await logForm.getByLabel('Note').fill('Landing page');
	await logForm.getByRole('button', { name: 'Log time' }).click();
	await expect(ela.getByRole('status')).toHaveText('Time logged.');
	await expect(ela.getByTestId('time-entry')).toHaveText([/WEB-1 · Website\s*7\.5\s*Landing page/]);
	await ela.getByRole('button', { name: 'Submit week for approval' }).click();
	await expect(ela.getByRole('status')).toHaveText('Timesheet submitted for approval.');
	await expect(ela.getByRole('region', { name: 'Log time' })).toHaveCount(0);

	const bossCtx = await browser.newContext();
	const boss = await bossCtx.newPage();
	await signIn(boss, f.users.boss.email);
	await expect(boss).toHaveURL(/\/t\//);
	await boss.goto(`/t/${slug}/approvals`);
	await boss.getByRole('link', { name: /ela .*: week of .* · 7\.5 h/ }).click();
	await expect(boss.getByTestId('time-entry')).toHaveCount(1);
	await boss.getByRole('button', { name: 'Approve timesheet' }).click();
	await expect(boss.getByRole('status')).toHaveText('Timesheet approved.');
	await expect(boss.getByRole('button', { name: 'Approve timesheet' })).toHaveCount(0);
	await bossCtx.close();

	await ela.reload();
	await expect(ela.getByRole('heading', { name: /Week of .* · 7\.5 h · Approved/ })).toBeVisible();
	await elaCtx.close();
});
