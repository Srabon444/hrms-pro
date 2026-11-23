import { expect, test } from '@playwright/test';
import { waitForMail } from '../mailpit';
import { fixture, signIn } from './fixtures';

const inDays = (n: number) =>
	new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });

test('an employee resigns, the manager agrees, HR accepts and the employee is on notice', async ({
	page,
	browser,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'boss', roles: ['employee'], employee: true },
			{ key: 'sam', roles: ['employee'], employee: true, manager: 'boss' },
			{ key: 'hr', roles: ['hr_admin'] }
		]
	});
	const profile = `/t/${f.tenant!.slug}/employees/${f.users.sam.employeeId}`;
	const as = async (key: string) => {
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		await signIn(p, f.users[key].email);
		return { ctx, p };
	};

	await signIn(page, f.users.sam.email);
	await page.goto(profile);
	const resign = page.getByRole('region', { name: 'Resign' });
	await expect(resign.getByLabel('My last working day')).toHaveValue(inDays(30));
	await resign.getByLabel('Why are you leaving?').fill('A new role abroad');
	await resign.getByRole('button', { name: 'Submit resignation' }).click();
	await expect(resign.getByRole('status')).toHaveText('Your resignation was sent.');
	await expect(resign.getByTestId('resignation-pending')).toContainText('your manager');

	const boss = await as('boss');
	await boss.p.goto(`/t/${f.tenant!.slug}/approvals`);
	await boss.p.getByRole('link', { name: /resigned$/ }).click();
	await expect(boss.p.getByTestId('requested-last-day')).toHaveText(inDays(30));
	await boss.p.getByRole('button', { name: 'Agree and send to HR' }).click();
	await expect(boss.p.getByRole('status')).toHaveText('Decision saved.');
	await boss.ctx.close();

	const hr = await as('hr');
	await hr.p.goto(`/t/${f.tenant!.slug}/approvals`);
	await hr.p.getByRole('link', { name: /resigned$/ }).click();
	await hr.p.getByLabel('Agreed last working day').fill(inDays(21));
	await hr.p.getByRole('button', { name: 'Accept' }).click();
	await expect(hr.p.getByRole('status')).toHaveText('Decision saved.');
	await hr.p.goto(profile);
	await expect(hr.p.getByTestId('fact-Status')).toHaveText('notice');
	await expect(hr.p.getByRole('region', { name: 'Exit' }).getByTestId('exit-pending')).toContainText(inDays(21));
	await hr.ctx.close();

	const mail = await waitForMail(f.users.sam.email, 15_000, 'Your resignation was accepted');
	expect(mail.subject).toContain(inDays(21));
	await page.reload();
	await expect(page.getByRole('region', { name: 'Resign' })).toHaveCount(0);
});
