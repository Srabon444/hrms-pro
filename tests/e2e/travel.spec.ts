import { expect, test, type Page } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };
const fits = async (page: Page) =>
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

test('an employee asks for a trip with an advance, the manager and finance approve, and the claim settles against it', async ({
	browser,
	request
}) => {
	test.setTimeout(120_000);
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'] },
			{ key: 'fin', roles: ['finance'] },
			{ key: 'mgr', roles: ['line_manager', 'employee'], employee: true },
			{ key: 'ana', roles: ['employee'], employee: true, manager: 'mgr' }
		]
	});
	const t = `/t/${f.tenant!.slug}`;
	const page = await (await browser.newContext({ viewport: PHONE })).newPage();
	const as = async (key: string, path: string) => {
		await page.context().clearCookies();
		await signIn(page, f.users[key].email);
		await page.goto(`${t}/${path}`);
		await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	};
	const status = page.getByRole('status');

	await as('own', 'settings/modules');
	expect((await page.goto(`${t}/travel`))!.status()).toBe(404);
	await page.goto(`${t}/settings/modules`);
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await page.getByLabel('Travel and per diem').check();
	await page.getByRole('button', { name: 'Save modules' }).click();
	await expect(page.getByText('Modules saved.')).toBeVisible();
	await as('own', 'travel');
	const rates = page.getByRole('region', { name: 'Per diem rates' });
	for (const [city, amount] of [
		['', '2000'],
		['Mumbai', '3000']
	]) {
		await rates.getByLabel('Country').fill('India');
		await rates.getByLabel('City (optional)').fill(city);
		await rates.getByLabel('Daily amount').fill(amount);
		await rates.getByRole('button', { name: 'Save rate' }).click();
		await expect(status).toHaveText('Per diem rate saved.');
	}
	await expect(page.getByTestId('rate')).toHaveCount(2);
	await fits(page);
	await page.goto(`${t}/expenses`);
	const cats = page.getByRole('region', { name: 'Categories' });
	await cats.getByLabel('New category name').fill('Taxi');
	await cats.getByRole('button', { name: 'Add category' }).click();
	await expect(status).toHaveText('Category saved.');

	await as('ana', 'travel');
	const form = page.getByRole('region', { name: 'New trip' });
	await form.getByLabel('Purpose').fill('Client workshop');
	await form.getByLabel('Country').fill('India');
	await form.getByLabel('City (optional)').fill('mumbai');
	await form.getByLabel('Leaving on').fill('2027-03-01');
	await form.getByLabel('Back on').fill('2027-03-04');
	await form.getByLabel(/Estimated cost/).fill('50000');
	await form.getByLabel(/Advance needed/).fill('20000');
	await form.getByRole('button', { name: 'Send for approval' }).click();
	await expect(status).toHaveText('Trip sent for approval.');
	const mine = page.getByTestId('my-trip');
	await expect(mine.getByTestId('trip-status')).toHaveText('Waiting for approval');
	await expect(mine.getByTestId('trip-money')).toHaveText('Per diem ৳3000.00 × 4 = ৳12000.00');
	await fits(page);

	await as('mgr', 'approvals');
	await page.getByRole('link', { name: /^ana .*: Client workshop, from 2027-03-01/ }).click();
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await page.getByRole('button', { name: /^Approve trip of ana/ }).click();
	await expect(status).toHaveText('Trip approved.');

	await as('fin', 'loans');
	await page.getByRole('button', { name: /^Approve request of ana/ }).click();
	await expect(status).toHaveText('Request approved.');

	await as('ana', 'expenses');
	const claim = page.getByRole('region', { name: 'New claim' });
	await claim.getByLabel('Title').fill('Mumbai costs');
	await claim.getByLabel('Trip (optional)').selectOption({ label: 'Client workshop · 2027-03-01 to 2027-03-04' });
	await expect(claim.getByLabel('Per diem guidance')).toContainText('per diem ৳3000.00 × 4 day(s) = ৳12000.00');
	const item = claim.getByRole('group').first();
	await item.getByLabel('Category').selectOption({ label: 'Taxi' });
	await item.getByLabel('Date').fill('2026-01-05');
	await item.getByLabel('Description').fill('Airport taxi');
	await item.getByLabel('Amount (৳)').fill('15000');
	await claim.getByRole('button', { name: 'Send claim' }).click();
	await expect(status).toHaveText('Expense claim sent for approval.');
	await expect(page.getByTestId('my-expense')).toContainText('Mumbai costs (trip: Client workshop)');

	await as('ana', 'travel');
	await expect(mine).toContainText('advance ৳20000.00 (approved, deducted from salary)');
	await expect(mine.getByTestId('trip-money')).toContainText('claimed ৳15000.00 · ৳5000.00 to pay back');
	await fits(page);
});
