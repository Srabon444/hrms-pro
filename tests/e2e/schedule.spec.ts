import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR rosters a shift on a phone, publishes it and staff see it', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	const sunday = new Date(Date.now() + 14 * 86_400_000);
	sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
	const week = sunday.toISOString().slice(0, 10);
	const friday = new Date(sunday.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
	const fits = async () =>
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

	await page.setViewportSize({ width: 390, height: 800 });
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('button', { name: 'Menu' }).click();
	await expect(page.getByRole('link', { name: 'Schedule', exact: true })).toBeVisible();
	await page.goto(`/t/${slug}/schedule?week=${week}`);
	const ela = page.getByRole('button', { name: new RegExp(`^ela \\S+ ${friday}`) });
	await expect(ela).toContainText('Rest');
	await fits();

	await ela.click();
	const edit = page.getByRole('region', { name: 'Edit schedule' });
	await edit.getByRole('combobox', { name: /^Shift/ }).selectOption({ label: 'General 09:00–18:00' });
	await edit.getByLabel('Note').fill('Stock count');
	await edit.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('status')).toHaveText('Schedule saved.');
	await expect(ela).toContainText('General 09:00–18:00');
	await expect(ela).toContainText('Draft');
	await page.getByRole('button', { name: 'Publish 1 drafts' }).click();
	await expect(page.getByRole('status')).toHaveText('1 entries published.');
	await expect(ela).not.toContainText('Draft');
	await fits();

	await page.context().clearCookies();
	await signIn(page, f.users.ela.email);
	await page.goto(`/t/${slug}/schedule?week=${week}`);
	await expect(page.getByTestId('schedule-grid')).toContainText('General 09:00–18:00');
	await expect(page.getByRole('button', { name: /Publish/ })).toHaveCount(0);
	const mine = page.getByRole('region', { name: 'My unavailable times' });
	await mine.getByLabel('Weekday').selectOption({ label: 'Tuesday' });
	await mine.getByLabel('From').fill('08:00');
	await mine.getByLabel('To', { exact: true }).fill('11:00');
	await mine.getByRole('button', { name: 'Add unavailable time' }).click();
	await expect(page.getByRole('status')).toHaveText('Unavailable time added.');
	await expect(mine.getByRole('listitem')).toHaveText([/Every Tuesday, 08:00–11:00/]);
	await fits();
	await page.goto(`/t/${slug}/notifications`);
	await expect(page.getByText(`Your schedule for the week of ${week} is published`)).toBeVisible();
});

test('staff swap a shift and take an open shift on a phone, and their manager approves both', async ({
	page,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'boss', roles: ['line_manager'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true, manager: 'boss' },
			{ key: 'fay', roles: ['employee'], employee: true, manager: 'boss' }
		]
	});
	const slug = f.tenant!.slug;
	const sunday = new Date(Date.now() + 14 * 86_400_000);
	sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
	const week = sunday.toISOString().slice(0, 10);
	const monday = new Date(sunday.getTime() + 86_400_000).toISOString().slice(0, 10);
	const thursday = new Date(sunday.getTime() + 4 * 86_400_000).toISOString().slice(0, 10);
	const fits = async () =>
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	const as = async (key: 'boss' | 'ela' | 'fay') => {
		await page.context().clearCookies();
		await signIn(page, f.users[key].email);
		await page.goto(`/t/${slug}/schedule?week=${week}`);
	};
	const cell = (name: string, date: string) => page.getByRole('button', { name: new RegExp(`^${name} \\S+ ${date}`) });

	await page.setViewportSize({ width: 390, height: 800 });
	await as('boss');
	await cell('ela', thursday).click();
	await page
		.getByRole('region', { name: 'Edit schedule' })
		.getByRole('combobox', { name: /^Shift/ })
		.selectOption({ label: 'General 09:00–18:00' });
	await page.getByRole('region', { name: 'Edit schedule' }).getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('status')).toHaveText('Schedule saved.');
	await page.getByRole('button', { name: 'Publish 1 drafts' }).click();
	await expect(page.getByRole('status')).toHaveText('1 entries published.');
	const open = page.getByRole('region', { name: 'Open shifts' });
	await open.getByLabel('Day').selectOption(monday);
	await open.getByLabel('Open shift').selectOption({ label: 'General 09:00–18:00' });
	await open.getByRole('button', { name: 'Post open shift' }).click();
	await expect(page.getByRole('status')).toHaveText('Open shift posted.');
	await fits();

	await as('ela');
	await open.getByRole('button', { name: 'Ask for this shift' }).click();
	await expect(page.getByRole('status')).toHaveText('Request sent to your approver.');
	await expect(open.getByText('You asked')).toBeVisible();
	const swap = page.getByRole('region', { name: 'Swap a shift' });
	await swap.getByLabel('Colleague').selectOption(f.users.fay.employeeId!);
	await swap.getByRole('button', { name: 'Ask to swap' }).click();
	await expect(page.getByRole('status')).toHaveText('Swap request sent.');
	await expect(page.getByRole('region', { name: 'My shift requests' })).toContainText('Waiting for colleague');
	await fits();

	await as('fay');
	const mine = page.getByRole('region', { name: 'My shift requests' });
	await expect(mine).toContainText(/ela \S+ asks me to take/);
	await expect(mine).toContainText('Waiting for you');
	await mine.getByRole('button', { name: 'Accept' }).click();
	await expect(page.getByRole('status')).toHaveText('Answer sent.');
	await expect(mine).toContainText('Waiting for approval');

	await as('boss');
	const inbox = page.getByRole('region', { name: 'Shift requests to approve' });
	await inbox.getByRole('listitem').filter({ hasText: 'gives' }).getByRole('button', { name: 'Approve' }).click();
	await expect(page.getByRole('status')).toHaveText('Swap approved and the schedule updated.');
	await inbox.getByRole('listitem').filter({ hasText: 'open shift' }).getByRole('button', { name: 'Approve' }).click();
	await expect(page.getByRole('status')).toHaveText('Decision saved.');
	await expect(cell('fay', thursday)).toContainText('General 09:00–18:00');
	await expect(cell('ela', thursday)).toContainText('Day off');
	await expect(cell('ela', monday)).toContainText('General 09:00–18:00');
	await expect(page.getByRole('region', { name: 'Shift requests to approve' })).toHaveCount(0);
	await fits();
});
