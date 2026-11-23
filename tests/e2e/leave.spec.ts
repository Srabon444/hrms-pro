import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an employee sees their leave balance and HR adjusts it', async ({ page, browser, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const profile = `/t/${f.tenant!.slug}/employees/${f.users.ela.employeeId}`;
	await signIn(page, f.users.hr.email);
	await page.goto(profile);
	const leave = page.getByRole('region', { name: 'Leave balance' });
	const casual = leave.getByTestId('leave-balance').filter({ hasText: 'Casual leave' });
	await expect(casual).toContainText('10 days');
	await leave.getByLabel('Leave type').selectOption({ label: 'Casual leave' });
	await leave.getByLabel(/Days to add/).fill('2');
	await leave.getByLabel('Reason').fill('Worked on Eid');
	await leave.getByRole('button', { name: 'Adjust balance' }).click();
	await expect(page.getByRole('status')).toHaveText('Leave balance adjusted.');
	await expect(casual).toContainText('12 days');

	const ctx = await browser.newContext();
	const ela = await ctx.newPage();
	await signIn(ela, f.users.ela.email);
	await ela.goto(profile);
	const own = ela.getByRole('region', { name: 'Leave balance' });
	await expect(own.getByTestId('leave-balance').filter({ hasText: 'Casual leave' })).toContainText('12 days');
	await expect(own.getByTestId('leave-balance').filter({ hasText: 'Unpaid leave' })).toContainText('no limit');
	await expect(own.getByRole('button', { name: 'Adjust balance' })).toHaveCount(0);
	await ctx.close();
});
