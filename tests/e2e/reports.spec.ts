import { expect, test } from '@playwright/test';
import { mailLink, waitForMail } from '../mailpit';
import { fixture, signIn } from './fixtures';

test('HR filters, downloads and shares part of the headcount report; employees cannot open reports', async ({
	page,
	browser
}) => {
	const f = await fixture(page.request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'] },
			{ key: 'boss', roles: ['hr_admin'] },
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

	await page.getByText('Share this report').click();
	const share = page.getByRole('form', { name: 'Share this report' });
	await share.getByRole('button', { name: 'Share' }).click();
	await expect(page.getByRole('alert')).toHaveText('Choose at least one person to share with.');
	await page.getByText('Share this report').click();
	await share.getByLabel('Joiners', { exact: true }).uncheck();
	await share.getByLabel('Attrition %').uncheck();
	await share.getByRole('checkbox', { name: /boss/ }).check();
	await share.getByRole('button', { name: 'Share' }).click();
	await expect(page).toHaveURL(/\/reports\/shared\//);
	const shared = page.url();
	await expect(page.getByTestId('share-period')).toContainText('2020-01-01 to 2020-12-31');
	await expect(page.getByRole('region', { name: 'Joiners' })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'By department' }).getByRole('columnheader')).toHaveText([
		'Department',
		'On 2020-01-01',
		'Joined',
		'Left',
		'After 2020-12-31'
	]);

	const mail = await waitForMail(f.users.boss.email, 20_000, 'Headcount and attrition');
	expect(mail.attachments).toEqual(['headcount-2020-01-01-2020-12-31.csv', 'headcount-2020-01-01-2020-12-31.pdf']);
	expect(mailLink(mail.text)).toBe(shared);
	const bossCtx = await browser.newContext();
	const boss = await bossCtx.newPage();
	await signIn(boss, f.users.boss.email);
	await expect(boss).toHaveURL(/\/t\//);
	await boss.goto(`/t/${slug}/reports`);
	await boss.getByTestId('shared-report').getByRole('link').click();
	await expect(boss.getByRole('heading', { level: 1 })).toHaveText('Headcount and attrition');
	await expect(boss.getByRole('region', { name: 'Leavers' })).toBeVisible();
	await bossCtx.close();

	const ctx = await browser.newContext();
	const ela = await ctx.newPage();
	await signIn(ela, f.users.ela.email);
	await expect(ela).toHaveURL(/\/t\//);
	await expect(ela.getByRole('link', { name: 'Reports', exact: true })).toHaveCount(0);
	expect((await ela.request.get(`/t/${slug}/reports`)).status()).toBe(403);
	expect((await ela.request.get(`/t/${slug}/reports/headcount`)).status()).toBe(404);
	expect((await ela.request.get(href!)).status()).toBe(404);
	expect((await ela.request.get(shared)).status()).toBe(404);
	await ctx.close();
});
