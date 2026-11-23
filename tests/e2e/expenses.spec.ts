import { expect, test } from '@playwright/test';
import { waitForMail } from '../mailpit';
import { fixture, signIn } from './fixtures';

test('an employee claims an expense with a receipt and finance pays it', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'fin', roles: ['finance'] },
			{ key: 'ana', roles: ['employee'], employee: true }
		]
	});
	await signIn(page, f.users.fin.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Expenses', exact: true }).click();
	const cats = page.getByRole('region', { name: 'Categories' });
	await cats.getByLabel('New category name').fill('Travel');
	await cats.getByLabel('Limit per claim', { exact: true }).fill('1000');
	await cats.getByRole('button', { name: 'Add category' }).click();
	await expect(page.getByRole('status')).toHaveText('Category saved.');

	await page.context().clearCookies();
	await signIn(page, f.users.ana.email);
	await page.goto(`/t/${f.tenant!.slug}/expenses`);
	const claim = page.getByRole('region', { name: 'New claim' });
	await claim.getByLabel('Title').fill('Client visit');
	await claim.getByRole('button', { name: 'Add item' }).click();
	const items = claim.getByRole('group');
	await items.nth(0).getByLabel('Category').selectOption({ label: 'Travel (up to ৳1000.00)' });
	await items.nth(0).getByLabel('Date').fill('2026-01-05');
	await items.nth(0).getByLabel('Description').fill('Taxi');
	await items.nth(0).getByLabel('Amount (৳)').fill('650');
	await items
		.nth(0)
		.getByLabel('Receipt')
		.setInputFiles({
			name: 'taxi.pdf',
			mimeType: 'application/pdf',
			buffer: Buffer.from('%PDF-1.7 taxi')
		});
	await items.nth(1).getByLabel('Category').selectOption({ label: 'Travel (up to ৳1000.00)' });
	await items.nth(1).getByLabel('Date').fill('2026-01-05');
	await items.nth(1).getByLabel('Description').fill('Bus');
	await items.nth(1).getByLabel('Amount (৳)').fill('400');
	await claim.getByRole('button', { name: 'Send claim' }).click();
	await expect(page.getByRole('alert')).toHaveText('Travel is limited to ৳1000.00 per claim.');

	await items.nth(1).getByLabel('Amount (৳)').fill('120.50');
	await claim.getByRole('button', { name: 'Send claim' }).click();
	await expect(page.getByRole('status')).toHaveText('Expense claim sent for approval.');
	const mine = page.getByTestId('my-expense');
	await expect(mine).toContainText('Client visit · ৳770.50 · Waiting for approval');
	const download = page.waitForEvent('download');
	await mine.getByRole('link', { name: 'Receipt for Taxi' }).click();
	expect((await download).suggestedFilename()).toBe('taxi.pdf');

	await page.context().clearCookies();
	await signIn(page, f.users.fin.email);
	await page.goto(`/t/${f.tenant!.slug}/approvals`);
	await page.getByRole('link', { name: /Client visit · ৳770\.50/ }).click();
	const toApprove = page.getByTestId('expense-to-approve');
	await toApprove.getByLabel('How to pay Client visit').selectOption({ label: 'Directly' });
	await toApprove.getByRole('button', { name: 'Approve Client visit' }).click();
	await expect(page.getByRole('status')).toHaveText('Expense claim approved.');
	await page.getByTestId('expense-to-pay').getByRole('button', { name: 'Mark Client visit paid' }).click();
	await expect(page.getByRole('status')).toHaveText('Expense claim marked paid.');

	const mail = await waitForMail(f.users.ana.email, 15_000, 'Expense claim paid: Client visit');
	expect(mail.text).toContain('৳770.50 was paid to you.');
	await page.context().clearCookies();
	await signIn(page, f.users.ana.email);
	await page.goto(`/t/${f.tenant!.slug}/expenses`);
	await expect(page.getByTestId('my-expense')).toContainText('Client visit · ৳770.50 · Paid');
});
