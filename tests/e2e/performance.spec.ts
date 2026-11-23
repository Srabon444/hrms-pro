import { expect, test, type Browser } from '@playwright/test';
import { fixture, signIn } from './fixtures';

async function as(browser: Browser, email: string) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await signIn(page, email);
	await expect(page).toHaveURL(/\/t\//);
	return page;
}

test('HR runs a review cycle from goals to a shared score', async ({ page, browser, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'] },
			{ key: 'boss', roles: ['line_manager'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true, manager: 'boss' }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${slug}/performance`);
	const create = page.getByRole('region', { name: 'New review cycle' });
	await create.getByLabel('Name').fill('H2 2026');
	await create.getByLabel('Period starts').fill('2026-07-01');
	await create.getByLabel('Period ends').fill('2026-06-01');
	await create.getByRole('button', { name: 'Open cycle' }).click();
	await expect(page.getByRole('alert')).toHaveText('The period must end on or after its start.');
	await create.getByLabel('Period ends').fill('2026-12-31');
	await create.getByRole('button', { name: 'Open cycle' }).click();
	await expect(page.getByRole('heading', { name: 'H2 2026' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Reviews' }).getByRole('row')).toHaveCount(3);

	const ela = await as(browser, f.users.ela.email);
	await ela.getByRole('link', { name: 'Performance', exact: true }).click();
	await ela
		.getByRole('region', { name: 'My reviews' })
		.getByRole('link', { name: /^H2 2026 · ela / })
		.click();
	const add = ela.getByRole('region', { name: 'Add goal' });
	for (const [goal, weight] of [
		['Ship billing', '60'],
		['Mentor juniors', '40']
	]) {
		await add.getByLabel('Goal').fill(goal);
		await add.getByLabel('Target').fill(`${goal} by December`);
		await add.getByLabel('Weight').fill(weight);
		await add.getByRole('button', { name: 'Add goal' }).click();
		await expect(ela.getByRole('status')).toHaveText('Goal saved.');
	}
	await expect(ela.getByTestId('goal')).toHaveCount(2);
	const self = ela.getByRole('region', { name: 'Self review' });
	await self.getByLabel('Result for Ship billing').fill('Shipped in November');
	await self.getByLabel('Your rating for Ship billing').selectOption('4');
	await self.getByLabel('Your rating for Mentor juniors').selectOption('5');
	await self.getByLabel('Comments').fill('A strong half');
	await self.getByRole('button', { name: 'Send self review' }).click();
	await expect(ela.getByRole('status')).toHaveText('Self review sent to your manager.');
	await expect(ela.getByRole('heading', { level: 1 })).toHaveText(/Manager review$/);
	await expect(ela.getByRole('region', { name: 'Add goal' })).toHaveCount(0);

	const boss = await as(browser, f.users.boss.email);
	await boss.goto(`/t/${slug}/performance`);
	await boss.getByRole('region', { name: 'Waiting for your rating' }).getByRole('link', { name: /ela / }).click();
	await expect(boss.getByTestId('goal').first()).toContainText('Result: Shipped in November');
	const rate = boss.getByRole('region', { name: 'Manager review' });
	await rate.getByLabel('Rating for Ship billing').selectOption('4');
	await rate.getByLabel('Rating for Mentor juniors').selectOption('3');
	await rate.getByLabel('Comments').fill('Keep it up');
	await rate.getByRole('button', { name: 'Send rating' }).click();
	await expect(boss.getByRole('status')).toHaveText('Rating sent to HR.');
	await expect(boss.getByText('Score 3.60 out of 5')).toBeVisible();

	await page.goto(`/t/${slug}/performance`);
	await page.getByRole('region', { name: 'Waiting to finalise' }).getByRole('link', { name: /ela / }).click();
	await page.getByRole('region', { name: 'Finalise' }).getByRole('button', { name: 'Finalise review' }).click();
	await expect(page.getByRole('status')).toHaveText('Review finalised.');

	await ela.reload();
	await expect(ela.getByText('HR has finalised this review and will share the result with you.')).toBeVisible();
	await expect(ela.getByText(/^Score /)).toHaveCount(0);
	await expect(ela.getByText('Keep it up')).toHaveCount(0);

	await page.getByRole('button', { name: /^Share with ela / }).click();
	await expect(page.getByRole('status')).toHaveText('Review shared with the employee.');
	await ela.reload();
	await expect(ela.getByText('Score 3.60 out of 5')).toBeVisible();
	await expect(ela.getByRole('region', { name: 'Manager comments' })).toHaveText(/Keep it up/);
});
