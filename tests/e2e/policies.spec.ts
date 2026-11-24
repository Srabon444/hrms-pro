import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const pdf = (text: string) => ({
	name: 'remote.pdf',
	mimeType: 'application/pdf',
	buffer: Buffer.from(`%PDF-1.7 ${text}`)
});

test('HR publishes a policy, staff acknowledge it and a new version asks again', async ({ page, browser, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'] },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Policies', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Policies');
	const create = page.getByRole('region', { name: 'New policy' });
	await create.getByLabel('Title').fill('Remote work');
	await create.getByLabel('Summary').fill('Two days a week from home.');
	await create.getByLabel('Policy PDF').setInputFiles({ ...pdf('x'), buffer: Buffer.from('MZ') });
	await create.getByRole('button', { name: 'Publish policy' }).click();
	await expect(page.getByRole('alert')).toHaveText('Upload the policy as a PDF.');
	await create.getByLabel('Policy PDF').setInputFiles(pdf('v1'));
	await create.getByRole('button', { name: 'Publish policy' }).click();
	await expect(page.getByTestId('policy')).toHaveCount(1);
	await expect(page.getByTestId('policy-progress')).toHaveText('0 of 1 acknowledged');

	const ctx = await browser.newContext();
	const ela = await ctx.newPage();
	await signIn(ela, f.users.ela.email);
	await expect(ela).toHaveURL(/\/t\//);
	await ela.getByRole('link', { name: 'Policies', exact: true }).click();
	await expect(ela.getByRole('region', { name: 'New policy' })).toHaveCount(0);
	const href = await ela.getByRole('link', { name: 'Read the policy' }).getAttribute('href');
	const res = await ela.request.get(href!);
	expect(res.status()).toBe(200);
	expect(res.headers()['content-disposition']).toContain('attachment');
	expect(await res.text()).toBe('%PDF-1.7 v1');
	await ela.getByRole('button', { name: 'I have read and accept it' }).click();
	await expect(ela.getByTestId('policy-acked')).toContainText('Acknowledged on');

	await page.reload();
	await expect(page.getByTestId('policy-progress')).toHaveText('1 of 1 acknowledged');
	await page.getByRole('link', { name: 'Remote work' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Remote work');
	await expect(page.getByTestId('policy-pending')).toHaveText('0 pending');
	await page.getByLabel('New version (PDF, optional)').setInputFiles(pdf('v2'));
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Version 2, published')).toBeVisible();
	await expect(page.getByTestId('policy-pending')).toHaveText('1 pending');
	await expect(page.getByTestId('policy-person')).toHaveText([/ela.*Pending/]);

	await ela.reload();
	await expect(ela.getByRole('button', { name: 'I have read and accept it' })).toBeVisible();
	expect(await (await ela.request.get(href!)).text()).toBe('%PDF-1.7 v2');
	await ctx.close();
});
