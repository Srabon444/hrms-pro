import { expect, test, type Page } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test.use({ viewport: { width: 390, height: 844 } });

const png = {
	name: 'scan.png',
	mimeType: 'image/png',
	buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
};
const pdf = { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 cv') };
const hydrated = (page: Page) => page.waitForSelector('html[data-hydrated]', { state: 'attached' });
const narrow = async (page: Page) =>
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

test('AI reads a receipt, a CV and a certificate and drafts text, all as suggestions', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'own', roles: ['owner'], employee: true }] });
	const t = `/t/${f.tenant!.slug}`;
	await signIn(page, f.users.own.email);

	await page.goto(`${t}/expenses`);
	await expect(page.getByRole('button', { name: 'Read receipt' })).toHaveCount(0);
	const cats = page.getByRole('region', { name: 'Categories' });
	await cats.getByLabel('New category name').fill('Meals');
	await cats.getByRole('button', { name: 'Add category' }).click();
	await expect(page.getByRole('status')).toHaveText('Category saved.');

	await page.goto(`${t}/settings/ai`);
	await page.getByLabel('Turn AI on for this company').check();
	await page.getByLabel(/text and files a feature needs are sent/).check();
	await page.getByRole('button', { name: 'Save AI settings' }).click();
	await expect(page.getByText('AI settings saved.')).toBeVisible();

	await page.goto(`${t}/expenses`);
	await hydrated(page);
	const claim = page.getByRole('region', { name: 'New claim' });
	await claim.getByLabel('Title').fill('Lunch with client');
	const item = claim.getByRole('group').nth(0);
	await item.getByRole('button', { name: 'Read receipt' }).click();
	await expect(item.getByTestId('ai-note')).toHaveText('Choose a file first.');
	await item.getByLabel('Receipt').setInputFiles(png);
	await item.getByRole('button', { name: 'Read receipt' }).click();
	await expect(item.getByTestId('ai-note')).toHaveText('Filled in. Check every value before you save.');
	await expect(item.getByLabel('Description')).toHaveValue('City Cafe');
	await expect(item.getByLabel('Date')).toHaveValue('2026-01-15');
	await expect(item.getByLabel('Amount (৳)')).toHaveValue('450.50');
	await expect(item.getByLabel('Category').locator('option:checked')).toHaveText('Meals');
	await narrow(page);
	await claim.getByRole('button', { name: 'Send claim' }).click();
	await expect(page.getByRole('status')).toHaveText('Expense claim sent for approval.');
	await expect(page.getByTestId('my-expense')).toContainText('Lunch with client · ৳450.50');

	await page.goto(`${t}/recruitment`);
	await hydrated(page);
	const open = page.getByRole('region', { name: 'New opening' });
	await open.getByRole('button', { name: 'Draft with AI' }).click();
	await expect(open.getByTestId('ai-note')).toHaveText('Write the job title first.');
	await open.getByLabel('Job title').fill('QA Engineer');
	await open.getByRole('button', { name: 'Draft with AI' }).click();
	await expect(open.getByLabel('Description')).toHaveValue(/^We are hiring/);
	await open.getByRole('button', { name: 'Open position' }).click();
	await expect(page.getByRole('heading', { name: 'QA Engineer · Open' })).toBeVisible();
	await hydrated(page);

	const add = page.getByRole('region', { name: 'Add candidate' });
	await add.getByLabel('Resume (PDF or Word, up to 10 MB)').setInputFiles(pdf);
	await add.getByRole('button', { name: 'Read CV' }).click();
	await expect(add.getByLabel('Full name')).toHaveValue('Rina Akter');
	await expect(add.getByLabel('Email')).toHaveValue('rina.akter@example.com');
	await expect(add.getByLabel('Tags (comma separated)')).toHaveValue('Playwright, SQL');
	await narrow(page);
	await add.getByRole('button', { name: 'Add candidate' }).click();
	await expect(page.getByRole('status')).toHaveText('Candidate added.');

	await page.goto(`${t}/employees/${f.users.own.employeeId}`);
	await hydrated(page);
	const docs = page.getByRole('region', { name: 'Documents' });
	await docs.getByLabel('File').setInputFiles({ ...png, name: 'cert.png' });
	await docs.getByLabel('Document type').selectOption('identity');
	await docs.getByRole('button', { name: 'Read document' }).click();
	await expect(docs.getByTestId('ai-note')).toHaveText('AI only reads certificates, letters and other documents.');
	await docs.getByLabel('Document type').selectOption('certificate');
	await docs.getByRole('button', { name: 'Read document' }).click();
	await expect(docs.getByLabel('Document title')).toHaveValue('AWS Certified Developer');
	await expect(docs.getByLabel('Expires on')).toHaveValue('2029-03-31');
	await narrow(page);

	await page.goto(`${t}/announcements`);
	await hydrated(page);
	const news = page.getByRole('region', { name: 'New announcement' });
	await news.getByLabel('Title').fill('Team outing');
	await news.getByRole('button', { name: 'Draft with AI' }).click();
	await expect(news.getByLabel('Message')).toHaveValue(/^The office will close early/);
	await narrow(page);
});
