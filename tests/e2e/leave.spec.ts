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

const workday = (from: number | string, offset = 0) => {
	const d = new Date(typeof from === 'number' ? Date.now() + from * 86_400_000 : `${from}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + offset);
	while ([5, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
};

test('an employee asks for leave, the manager approves it and the employee cancels it', async ({
	page,
	browser,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'boss', roles: ['line_manager'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true, manager: 'boss' }
		]
	});
	const slug = f.tenant!.slug;
	const start = workday(14);
	const from = new Date(start).getUTCDay() === 4 ? workday(start, 3) : start;
	const to = workday(from, 1);
	await signIn(page, f.users.ela.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Leave', exact: true }).click();
	const form = page.getByRole('region', { name: 'Request leave' });
	await form.getByLabel('Leave type').selectOption({ label: 'Casual leave' });
	await form.getByLabel('From', { exact: true }).fill(from);
	await form.getByLabel('To', { exact: true }).fill(to);
	await form.getByLabel('Reason').fill('Family visit');
	await form.getByRole('button', { name: 'Request leave' }).click();
	await expect(page.getByRole('status')).toHaveText('Leave requested.');
	const casual = page
		.getByRole('region', { name: 'My balance' })
		.getByTestId('leave-balance')
		.filter({ hasText: 'Casual leave' });
	await expect(casual).toContainText('8 days left · 2 pending');
	const mine = page.getByRole('region', { name: 'My requests' }).getByTestId('leave-request');
	await expect(mine).toHaveText([/Casual leave · .* · 2 days · pending/]);

	const ctx = await browser.newContext();
	const boss = await ctx.newPage();
	await signIn(boss, f.users.boss.email);
	await boss.goto(`/t/${slug}/approvals`);
	await boss.getByRole('link', { name: /Casual leave, 2 days/ }).click();
	await expect(boss.getByTestId('leave-days')).toContainText(`2 · ${from}, ${to}`);
	await boss.getByRole('button', { name: 'Approve' }).click();
	await expect(boss.getByRole('status')).toHaveText('Decision saved.');
	await ctx.close();

	await page.reload();
	await expect(casual).toContainText('8 days left');
	await expect(casual).not.toContainText('pending');
	await expect(mine).toHaveText([/2 days · approved/]);
	await expect(page.getByRole('region', { name: 'Who is out' }).getByTestId('out')).toHaveText([
		new RegExp(`${from} · .* · Casual leave`),
		new RegExp(`${to} · .* · Casual leave`)
	]);
	await page.getByRole('button', { name: `Cancel Casual leave from ${from}` }).click();
	await expect(page.getByRole('status')).toHaveText('Leave cancelled.');
	await expect(casual).toContainText('10 days left');
	await expect(mine).toHaveText([/2 days · cancelled/]);
});
