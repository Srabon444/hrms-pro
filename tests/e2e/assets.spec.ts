import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('IT registers a laptop, hands it to an employee who sees it, then takes it back damaged', async ({
	page,
	browser,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'it', roles: ['it_asset_manager'] },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.it.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Assets', exact: true }).click();
	const create = page.getByRole('region', { name: 'New asset' });
	await create.getByLabel('Tag').fill('lap-7');
	await create.getByLabel('Name').fill('ThinkPad');
	await create.getByLabel('Category').fill('Laptop');
	await create.getByLabel('Purchase cost (৳)').fill('95000');
	await create.getByRole('button', { name: 'Add asset' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('LAP-7 · ThinkPad');
	const hand = page.getByRole('region', { name: 'Hand over' });
	await hand.getByLabel('Employee').selectOption(f.users.ela.employeeId!);
	await hand.getByRole('button', { name: 'Hand over' }).click();
	await expect(page.getByRole('status')).toHaveText('Asset handed over.');
	await expect(page.getByTestId('asset-history')).toHaveText([/ela .* · from .* \(Good\)\s*· still with them/]);

	const ctx = await browser.newContext();
	const ela = await ctx.newPage();
	await signIn(ela, f.users.ela.email);
	await expect(ela).toHaveURL(/\/t\//);
	await ela.goto(`/t/${slug}`);
	await ela.getByRole('link', { name: 'Assets', exact: true }).click();
	await expect(ela.getByTestId('asset')).toHaveText([/LAP-7\s*ThinkPad\s*Laptop\s*Assigned\s*ela /]);
	await expect(ela.getByRole('region', { name: 'New asset' })).toHaveCount(0);
	await ctx.close();

	const back = page.getByRole('region', { name: 'Take back' });
	await back.getByLabel('Condition on return').selectOption('damaged');
	await back.getByLabel('Charge to employee (৳)').fill('2000');
	await back.getByRole('button', { name: 'Close out' }).click();
	await expect(page.getByRole('status')).toHaveText('Asset closed out.');
	await expect(page.getByText('Laptop · In repair')).toBeVisible();
	await expect(page.getByTestId('asset-history')).toHaveText([/returned .* \(Damaged\) · charged ৳2000\.00/]);
});
