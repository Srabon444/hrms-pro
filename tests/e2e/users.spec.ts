import { expect, test } from '@playwright/test';
import { mailLink, waitForMail } from '../mailpit';
import { PASSWORD, fixture, signIn } from './fixtures';

test('employees cannot open user management and do not see it in the menu', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'emp' }] });
	await signIn(page, f.users.emp.email);
	await expect(page.getByRole('navigation', { name: 'Main' })).not.toContainText('Users');
	expect((await page.goto(`/t/${f.tenant!.slug}/settings/users`))?.status()).toBe(403);
});

test('HR invites a recruiter who joins, then changes their roles and the member is notified', async ({
	page,
	browser,
	request
}) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	await page.getByRole('link', { name: 'Users' }).click();
	await expect(page.getByLabel('Payroll Officer')).toHaveCount(0);

	const email = `recruit-${Date.now().toString(36)}@e2e.local`;
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Recruiter').check();
	await page.getByRole('button', { name: 'Send invitation' }).click();
	await expect(page.getByRole('status')).toHaveText(`Invitation sent to ${email}.`);

	const joiner = await browser.newPage();
	await joiner.goto(new URL(mailLink((await waitForMail(email)).text)).pathname);
	await joiner.getByLabel('Your name').fill('Rita Recruiter');
	await joiner.getByLabel('Password', { exact: true }).fill(PASSWORD);
	await joiner.getByLabel('Repeat password').fill(PASSWORD);
	await joiner.getByRole('button', { name: 'Create account and join' }).click();
	await expect(joiner).toHaveURL(`/t/${f.tenant!.slug}`);

	await page.reload();
	const row = page.getByRole('row', { name: /Rita Recruiter/ });
	await expect(row).toContainText('Recruiter');
	await row.getByRole('link', { name: 'Rita Recruiter' }).click();
	await page.getByLabel('Recruiter').uncheck();
	await page.getByLabel('HR Officer').check();
	await page.getByRole('button', { name: 'Save roles' }).click();
	await expect(page.getByRole('status')).toHaveText('Roles updated.');

	await joiner.reload();
	await expect(joiner.getByTestId('unread-count')).toHaveText('1');
	await joiner.getByRole('link', { name: /Notifications/ }).click();
	await expect(joiner.getByTestId('notification')).toContainText('Your roles in');
	await joiner.getByRole('button', { name: 'Mark all as read' }).click();
	await expect(joiner.getByTestId('unread-count')).toHaveCount(0);

	await page.getByRole('button', { name: 'Disable access' }).click();
	await expect(page.getByRole('status')).toHaveText('Access disabled.');
	expect((await joiner.goto(`/t/${f.tenant!.slug}`))?.status()).toBe(404);
});
