import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR filters the headcount report and downloads it; employees cannot open reports', async ({ page, browser }) => {
	const f = await fixture(page.request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'] },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.hr.email);
	await expect(page).toHaveURL(/\/t\//);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Reports', exact: true }).click();
	await page.getByRole('link', { name: 'Headcount and attrition' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Headcount and attrition');
	const filters = page.getByRole('form', { name: 'Filters' });
	await filters.getByLabel('From').fill('2026-02-01');
	await filters.getByLabel('To').fill('2026-01-01');
	await filters.getByRole('button', { name: 'Show' }).click();
	await expect(page.getByRole('alert')).toHaveText('The start date must be on or before the end date.');
	await filters.getByLabel('From').fill('2020-01-01');
	await filters.getByLabel('To').fill('2020-12-31');
	await filters.getByRole('button', { name: 'Show' }).click();
	await expect(page.getByRole('region', { name: 'By department' }).getByTestId('row-departments')).toHaveText([
		/All departments\s*0\s*0\s*0\s*0\s*—/
	]);
	const href = await page.getByRole('link', { name: 'Download CSV' }).getAttribute('href');
	const csv = await page.request.get(href!);
	expect(csv.status()).toBe(200);
	expect(csv.headers()['content-disposition']).toContain('headcount-2020-01-01-2020-12-31.csv');
	expect((await csv.text()).split('\r\n')[1]).toBe('2020-01-01 to 2020-12-31');
	const pdf = await page.request.get((await page.getByRole('link', { name: 'Download PDF' }).getAttribute('href'))!);
	expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

	const ctx = await browser.newContext();
	const ela = await ctx.newPage();
	await signIn(ela, f.users.ela.email);
	await expect(ela).toHaveURL(/\/t\//);
	await expect(ela.getByRole('link', { name: 'Reports', exact: true })).toHaveCount(0);
	expect((await ela.request.get(`/t/${slug}/reports`)).status()).toBe(403);
	expect((await ela.request.get(`/t/${slug}/reports/headcount`)).status()).toBe(404);
	expect((await ela.request.get(href!)).status()).toBe(404);
	await ctx.close();
});
