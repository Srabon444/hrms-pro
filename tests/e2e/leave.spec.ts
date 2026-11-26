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
	await leave.getByLabel('Leave type').selectOption({ label: 'Casual leave' });
	await leave.getByLabel(/Days to add/).fill('1');
	await leave.getByLabel('Reason').fill('W'.repeat(480));
	await leave.getByRole('button', { name: 'Adjust balance' }).click();
	await expect(page.getByRole('status')).toHaveText('Leave balance adjusted.');
	await ela.setViewportSize({ width: 390, height: 800 });
	await ela.goto(`/t/${f.tenant!.slug}/leave`);
	await ela.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	const card = ela.getByTestId('leave-balance').filter({ hasText: 'Casual leave' });
	await card.getByText('History').click();
	await expect(card.getByTestId('leave-entry').first()).toContainText('Changed by HR: WWW');
	expect(await ela.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
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
	const numbers = casual.getByTestId('leave-numbers');
	await expect(numbers).toContainText('Balance today 10 days');
	await expect(numbers).toContainText('After approved leave still to come 8 days');
	await expect(casual.getByTestId('leave-rule')).toHaveText(
		'10 days a year, added at the start of the year, less for people who join mid-year. Unused days lapse at year end.'
	);
	await page.setViewportSize({ width: 390, height: 800 });
	await casual.getByText('History').click();
	const entries = casual.getByRole('list', { name: 'Casual leave history' }).getByTestId('leave-entry');
	await expect(entries.first()).toContainText(`Leave ${from} to ${to}`);
	await expect(entries.first()).toContainText('-2');
	await expect(entries.first()).toContainText('balance 8');
	await expect(entries.last()).toContainText('Added for the year');
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(page.getByRole('region', { name: 'Who is out' }).getByTestId('out')).toHaveText([
		new RegExp(`${from} · .* · Casual leave`),
		new RegExp(`${to} · .* · Casual leave`)
	]);
	await page.getByRole('button', { name: `Cancel Casual leave from ${from}` }).click();
	await expect(page.getByRole('status')).toHaveText('Leave cancelled.');
	await expect(casual).toContainText('10 days left');
	await expect(mine).toHaveText([/2 days · cancelled/]);
});

test('an employee attaches a prescription, replaces it and the manager downloads it', async ({
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
	const day = workday(20);
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
	await signIn(page, f.users.ela.email);
	await page.goto(`/t/${slug}/leave`);
	const form = page.getByRole('region', { name: 'Request leave' });
	await form.getByLabel('Leave type').selectOption({ label: 'Sick leave' });
	await form.getByLabel('From', { exact: true }).fill(day);
	await form.getByLabel(/Attachments/).setInputFiles({ name: 'rx.png', mimeType: 'image/png', buffer: png });
	await form.getByRole('button', { name: 'Request leave' }).click();
	await expect(page.getByRole('status')).toHaveText('Leave requested.');
	await page
		.getByRole('region', { name: 'My requests' })
		.getByRole('link', { name: /Sick leave/ })
		.click();
	const files = page.getByRole('region', { name: 'Attachments' });
	await expect(files.getByTestId('attachment')).toHaveText([/rx\.png/]);
	await files.getByLabel('Replacement for rx.png').setInputFiles({
		name: 'rx-final.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from('%PDF-1.7 final')
	});
	await files.getByRole('button', { name: 'Replace', exact: true }).click();
	await expect(files.getByRole('status')).toHaveText('Attachments updated.');
	await expect(files.getByTestId('attachment')).toHaveText([/rx-final\.pdf/]);

	const ctx = await browser.newContext();
	const boss = await ctx.newPage();
	await signIn(boss, f.users.boss.email);
	await boss.goto(`/t/${slug}/approvals`);
	await boss.getByRole('link', { name: /Sick leave/ }).click();
	const shown = boss.getByRole('region', { name: 'Attachments' });
	await expect(shown.getByRole('button', { name: 'Replace', exact: true })).toHaveCount(0);
	const download = boss.waitForEvent('download');
	await shown.getByRole('link', { name: 'rx-final.pdf' }).click();
	expect((await download).suggestedFilename()).toBe('rx-final.pdf');
	await ctx.close();
});
