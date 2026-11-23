import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an employee raises tickets, IT works the open one and the confidential one stays hidden', async ({
	page,
	browser,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'ela', roles: ['employee'], employee: true },
			{ key: 'it', roles: ['it_asset_manager'] }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.ela.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Helpdesk', exact: true }).click();
	const raise = page.getByRole('region', { name: 'Raise a ticket' });
	await raise.getByLabel('Category').selectOption({ label: 'Grievance (confidential)' });
	await raise.getByLabel('Subject').fill('Private matter');
	await raise.getByLabel('Description').fill('Details only HR may see');
	await raise.getByRole('button', { name: 'Raise ticket' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('#1 · Private matter');
	await page.getByRole('link', { name: 'Helpdesk', exact: true }).first().click();
	await raise.getByLabel('Category').selectOption({ label: 'IT support' });
	await raise.getByLabel('Priority').selectOption('high');
	await raise.getByLabel('Subject').fill('VPN down');
	await raise.getByLabel('Description').fill('Cannot connect since morning');
	await raise.getByRole('button', { name: 'Raise ticket' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('#2 · VPN down');
	await expect(page.getByRole('region', { name: 'Handle ticket' })).toHaveCount(0);

	const ctx = await browser.newContext();
	const it = await ctx.newPage();
	await signIn(it, f.users.it.email);
	await expect(it).toHaveURL(/\/t\//);
	await it.goto(`/t/${slug}/helpdesk`);
	await expect(it.getByTestId('ticket')).toHaveText([/^2\s*VPN down\s*IT support\s*ela .*High\s*Open\s*—/]);
	await expect(it.getByRole('region', { name: 'Raise a ticket' })).toHaveCount(0);
	await it.getByRole('link', { name: 'VPN down' }).click();
	const handle = it.getByRole('region', { name: 'Handle ticket' });
	await handle.getByLabel('Status').selectOption('waiting');
	await handle.getByLabel('Handled by').selectOption({ index: 1 });
	await handle.getByRole('button', { name: 'Save' }).click();
	await expect(it.getByRole('status')).toHaveText('Ticket updated.');
	await expect(it.getByTestId('ticket-status')).toHaveText('Waiting on requester');
	await it.getByLabel('Comment').fill('Restart the router first');
	await it.getByLabel('Internal note').check();
	await it.getByRole('button', { name: 'Add comment' }).click();
	await expect(it.getByRole('status')).toHaveText('Comment added.');
	await it.getByLabel('Comment').fill('Which office are you in?');
	await it.getByRole('button', { name: 'Add comment' }).click();
	await expect(it.getByTestId('ticket-comment')).toHaveCount(2);

	await page.reload();
	await expect(page.getByTestId('ticket-comment')).toHaveText([/Which office are you in\?/]);
	await page.getByLabel('Comment').fill('Dhaka office');
	await page.getByRole('button', { name: 'Add comment' }).click();
	await expect(page.getByTestId('ticket-status')).toHaveText('Open');

	await it.reload();
	await handle.getByLabel('Status').selectOption('resolved');
	await handle.getByRole('button', { name: 'Save' }).click();
	await expect(it.getByTestId('ticket-status')).toHaveText('Resolved');
	await ctx.close();

	await page.reload();
	await page.getByRole('region', { name: 'Confirm the fix' }).getByRole('button', { name: 'Yes, close it' }).click();
	await expect(page.getByTestId('ticket-status')).toHaveText('Closed');
	await expect(page.getByLabel('Comment')).toHaveCount(0);
});
