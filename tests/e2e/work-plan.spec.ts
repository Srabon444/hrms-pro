import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an employee plans the week, finishes one item and carries the rest; their manager sees it', async ({
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
	await signIn(page, f.users.ela.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Work plan', exact: true }).click();
	const add = page.getByRole('region', { name: 'Add item' });
	for (const item of ['Write billing spec', 'Review PRs']) {
		await add.getByLabel('Item').fill(item);
		await add.getByLabel('Target').fill('1');
		await add.getByRole('button', { name: 'Add item' }).click();
		await expect(page.getByRole('status')).toHaveText('Item added.');
	}
	await expect(page.getByTestId('work-item')).toHaveCount(2);
	await page.getByLabel('Status of Write billing spec').selectOption('done');
	await page.getByRole('button', { name: 'Update Write billing spec' }).click();
	await expect(page.getByRole('status')).toHaveText('Status updated.');
	await page.getByRole('button', { name: 'Carry unfinished items to next week' }).click();
	await expect(page.getByRole('status')).toHaveText(
		/^1 unfinished item\(s\) carried to the week of \d{4}-\d{2}-\d{2}\.$/
	);
	await page.getByRole('link', { name: 'Next week' }).click();
	await expect(page.getByTestId('work-item')).toHaveText([/Review PRs · target 1 · carried over/]);

	const ctx = await browser.newContext();
	const boss = await ctx.newPage();
	await signIn(boss, f.users.boss.email);
	await expect(boss).toHaveURL(/\/t\//);
	await boss.goto(`/t/${slug}/work-plan`);
	await expect(boss.getByTestId('work-item')).toHaveCount(2);
	await expect(boss.getByTestId('work-item').first()).toContainText(/ela /);
	await ctx.close();
});
