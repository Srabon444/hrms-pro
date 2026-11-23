import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test('HR records an exit, the leaver keeps only their own records, and HR rehires them', async ({
	page,
	browser,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'] },
			{ key: 'lee', roles: ['employee'], employee: true },
			{ key: 'peer', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	const profile = `/t/${slug}/employees/${f.users.lee.employeeId}`;
	await signIn(page, f.users.hr.email);
	await page.goto(profile);
	const exit = page.getByRole('region', { name: 'Exit' });

	await exit.getByLabel('Last working day').fill(inDays(10));
	await exit.getByLabel('Exit type').selectOption('resignation');
	await exit.getByRole('button', { name: 'Record exit' }).click();
	await expect(page.getByRole('status')).toHaveText('Exit recorded.');
	await expect(exit.getByTestId('exit-pending')).toContainText(inDays(10));
	await page.getByRole('link', { name: 'Lifecycle' }).click();
	await expect(page.getByRole('region', { name: 'Upcoming exits' }).getByTestId('exit-row')).toHaveCount(1);
	await page.goto(profile);
	await exit.getByRole('button', { name: 'Withdraw exit' }).click();
	await expect(page.getByRole('status')).toHaveText('Exit withdrawn.');

	await exit.getByLabel('Last working day').fill(inDays(0));
	await exit.getByLabel('Exit type').selectOption('termination');
	await exit.getByRole('button', { name: 'Record exit' }).click();
	await expect(page.getByRole('status')).toHaveText('Exit recorded.');
	await expect(page.getByTestId('fact-Status')).toHaveText('exited');

	const ctx = await browser.newContext();
	const lee = await ctx.newPage();
	await signIn(lee, f.users.lee.email);
	await lee.goto(profile);
	await expect(lee.getByTestId('fact-Status')).toHaveText('exited');
	await expect(lee.getByRole('link', { name: 'Lifecycle' })).toHaveCount(0);
	const interview = lee.getByRole('region', { name: 'Exit interview' });
	await interview.getByLabel('Main reason for leaving').selectOption('growth');
	await interview.getByLabel('Would come back').check();
	await interview.getByLabel('Anything else?').fill('Thanks for everything');
	await interview.getByRole('button', { name: 'Submit exit interview' }).click();
	await expect(interview.getByTestId('exit-interview-done')).toBeVisible();
	expect((await lee.goto(`/t/${slug}/employees/${f.users.peer.employeeId}`))!.status()).toBe(404);
	await ctx.close();

	await page.reload();
	await expect(page.getByTestId('exit-interview')).toContainText('Thanks for everything');

	const rehire = page.getByRole('region', { name: 'Rehire' });
	await rehire.getByLabel('New join date').fill(inDays(1));
	await rehire.getByRole('button', { name: 'Rehire' }).click();
	await expect(page.getByRole('status')).toHaveText('Rehired.');
	await expect(page.getByTestId('fact-Status')).toHaveText('onboarding');
	await expect(page.getByTestId('history').first()).toContainText('Status: exited → onboarding');
});
