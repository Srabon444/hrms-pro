import PDFDocument from 'pdfkit';
import { expect, test, type Page } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const pdf = () =>
	new Promise<Buffer>((resolve) => {
		const doc = new PDFDocument();
		const chunks: Buffer[] = [];
		doc.on('data', (c: Buffer) => chunks.push(c));
		doc.on('end', () => resolve(Buffer.concat(chunks)));
		doc.text(
			'Every member of staff gets twenty days of annual leave each year, and up to five unused days carry over.'
		);
		doc.end();
	});
const png = {
	name: 'cv.png',
	mimeType: 'image/png',
	buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
};

async function search(page: Page, slug: string, q: string) {
	await page.goto(`/t/${slug}`);
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await page.getByRole('button', { name: /^Search/ }).click();
	await page.getByRole('combobox', { name: 'Find pages and records' }).fill(q);
}

test('search finds words inside a policy PDF and inside a scanned CV image', async ({ page, browser, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.own.email);

	await page.goto(`/t/${slug}/policies`);
	const create = page.getByRole('region', { name: 'New policy' });
	await create.getByLabel('Title').fill('Time off');
	await create
		.getByLabel('Policy PDF')
		.setInputFiles({ name: 'leave.pdf', mimeType: 'application/pdf', buffer: await pdf() });
	await create.getByRole('button', { name: 'Publish policy' }).click();
	await expect(page.getByTestId('policy')).toHaveCount(1);

	await page.goto(`/t/${slug}/settings/ai`);
	await page.getByLabel('Turn AI on for this company').check();
	await page.getByLabel(/text and files a feature needs are sent/).check();
	await page.getByRole('button', { name: 'Save AI settings' }).click();
	await expect(page.getByText('AI settings saved.')).toBeVisible();

	await page.goto(`/t/${slug}/recruitment`);
	const open = page.getByRole('region', { name: 'New opening' });
	await open.getByLabel('Job title').fill('Night guard');
	await open.getByRole('button', { name: 'Open position' }).click();
	await expect(page.getByRole('heading', { name: 'Night guard · Open' })).toBeVisible();
	const add = page.getByRole('region', { name: 'Add candidate' });
	await add.getByLabel('Full name').fill('Imran Hossain');
	await add.getByLabel('Resume (PDF, Word or image, up to 10 MB)').setInputFiles(png);
	await add.getByRole('button', { name: 'Add candidate' }).click();
	await expect(page.getByRole('status')).toHaveText('Candidate added.');

	await expect(async () => {
		await search(page, slug, 'night shift allowance');
		await expect(
			page.getByRole('group', { name: 'Candidates' }).getByRole('option', { name: /Imran Hossain/ })
		).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 30_000 });

	const ctx = await browser.newContext();
	const ela = await ctx.newPage();
	await signIn(ela, f.users.ela.email);
	await expect(async () => {
		await search(ela, slug, 'annual leave');
		await expect(
			ela.getByRole('group', { name: 'Policies' }).getByRole('option', { name: /Time off.*annual leave/ })
		).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 30_000 });
	await search(ela, slug, 'night shift allowance');
	await expect(ela.getByRole('group', { name: 'Candidates' })).toHaveCount(0);
	await ctx.close();
});
