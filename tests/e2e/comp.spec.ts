import { expect, test, type Page } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };
const fits = async (page: Page) =>
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

test('a manager proposes a raise, payroll applies the review and finance approves the salary change', async ({
	browser,
	request
}) => {
	test.setTimeout(120_000);
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'po', roles: ['payroll_officer'] },
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

	await as('po', 'payroll/salaries');
	const offer = page.getByRole('region', { name: 'New salary' });
	await offer.getByLabel('Employee').selectOption(f.users.ana.employeeId!);
	await offer.getByLabel('Starts on').fill('2026-01-05');
	await offer.getByLabel('Basic (৳)').fill('30000');
	await offer.getByLabel('Reason').fill('Offer letter');
	await offer.getByRole('button', { name: 'Send for approval' }).click();
	await expect(status).toHaveText('Salary change sent for approval.');
	await as('fin', 'payroll/salaries');
	await page.getByRole('button', { name: /^Approve salary of ana/ }).click();
	await expect(status).toHaveText('Salary change approved.');

	await as('po', 'payroll/reviews');
	const start = page.getByRole('region', { name: 'New pay review' });
	await start.getByLabel('Name').fill('Mid-year 2026');
	await start.getByLabel('New salaries start on').fill('2026-07-01');
	await start.getByLabel(/Guideline/).fill('8');
	await start.getByRole('button', { name: 'Start pay review' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mid-year 2026');
	await fits(page);

	await as('mgr', 'payroll/reviews');
	await page.getByRole('link', { name: 'Mid-year 2026' }).click();
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	const rows = page.getByTestId('proposal-row');
	await expect(rows).toHaveCount(1);
	await page.getByLabel('Raise % for ana').fill('10');
	await page.getByLabel('Reason for ana').fill('Strong year');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(status).toHaveText('Proposal saved.');
	await expect(rows.first()).toContainText('10% · above guideline');
	await expect(rows.first()).not.toContainText('৳');
	await fits(page);

	await as('po', 'payroll/reviews');
	await page.getByRole('link', { name: 'Mid-year 2026' }).click();
	await expect(page.getByTestId('proposal-row').filter({ hasText: 'ana' })).toContainText('৳33000.00');
	await page.getByRole('button', { name: 'Apply proposals' }).click();
	await expect(status).toHaveText('1 salary change sent for approval.');
	await expect(page.getByTestId('proposal-row').filter({ hasText: 'ana' }).getByTestId('proposal-status')).toHaveText(
		'Sent for approval'
	);
	await fits(page);

	await as('fin', 'payroll/salaries');
	await expect(page.getByTestId('salary-change')).toContainText('Mid-year 2026: Strong year');
	await page.getByRole('button', { name: /^Approve salary of ana/ }).click();
	await expect(status).toHaveText('Salary change approved.');
	await expect(page.getByTestId('salary-row').filter({ hasText: 'ana' })).toContainText('৳33000.00');
});
