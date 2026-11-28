import { expect, type Page, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };
const fits = async (page: Page) =>
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

test('HR lists a job on the careers page and a visitor applies with a CV on a phone', async ({ browser, request }) => {
	test.setTimeout(90_000);
	const f = await fixture(request, { tenant: {}, users: [{ key: 'own', roles: ['owner'], employee: true }] });
	const slug = f.tenant!.slug;
	const own = await (await browser.newContext({ viewport: PHONE })).newPage();
	await signIn(own, f.users.own.email);
	await own.waitForURL(new RegExp(`/t/${slug}`));

	const visitor = await browser.newContext({ viewport: PHONE });
	const guest = await visitor.newPage();
	expect((await guest.goto(`/careers/${slug}`))!.status()).toBe(404);

	await own.goto(`/t/${slug}/settings/modules`);
	await own.getByLabel('Careers page').check();
	await own.getByRole('button', { name: 'Save modules' }).click();
	await expect(own.getByText('Modules saved.')).toBeVisible();

	await own.goto(`/t/${slug}/recruitment`);
	const create = own.getByRole('region', { name: 'New opening' });
	await create.getByLabel('Job title').fill('Field Officer');
	await create.getByRole('button', { name: 'Open position' }).click();
	await expect(own.getByRole('heading', { name: 'Field Officer · Open' })).toBeVisible();
	await own.locator('html[data-hydrated]').waitFor();
	const edit = own.getByRole('region', { name: 'Edit opening' });
	const choices = await edit.getByRole('combobox', { name: 'Who can see it' }).locator('option').allTextContents();
	expect(choices.map((c) => c.trim())).toEqual(['Only the hiring team', 'Public careers page']);
	await edit.getByRole('combobox', { name: 'Who can see it' }).selectOption('public');
	await edit.getByLabel('Description').fill('Visit **sites** daily.');
	await edit.getByRole('button', { name: 'Save opening' }).click();
	await expect(own.getByRole('status')).toHaveText('Opening saved.');
	await expect(own.getByRole('link', { name: `/careers/${slug}/field-officer` })).toBeVisible();
	await fits(own);

	await visitor.setExtraHTTPHeaders({ 'x-test-now': '2026-11-24T09:00:00+06:00' });
	await guest.goto(`/careers/${slug}`);
	await guest.getByRole('link', { name: 'Field Officer' }).click();
	await expect(guest.getByRole('heading', { name: 'Field Officer' })).toBeVisible();
	await expect(guest.locator('.markdown strong')).toHaveText('sites');
	await guest.locator('html[data-hydrated]').waitFor();
	await fits(guest);

	const form = guest.getByRole('region', { name: 'Apply' });
	await form.getByLabel('Full name').fill('Mitu Rahman');
	await form.getByLabel('Email').fill(`mitu-${slug}@example.com`);
	await form
		.getByLabel('CV (PDF, up to 5 MB)')
		.setInputFiles({ name: 'mitu.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 mitu') });
	await form.getByRole('checkbox').check();
	await visitor.setExtraHTTPHeaders({ 'x-test-now': '2026-11-24T09:00:10+06:00' });
	await form.getByRole('button', { name: 'Send application' }).click();
	await expect(guest.getByRole('status')).toHaveText('Thank you. Your application has been received.');
	await fits(guest);

	await own.reload();
	await expect(own.getByRole('link', { name: 'Mitu Rahman' })).toBeVisible();
	await own.getByRole('link', { name: 'Mitu Rahman' }).click();
	await expect(own.getByRole('heading', { name: /Mitu Rahman/ })).toBeVisible();
	await expect(own.getByRole('link', { name: /mitu\.pdf/ })).toBeVisible();
});
