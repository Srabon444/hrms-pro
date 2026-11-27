import PDFDocument from 'pdfkit';
import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test.use({ viewport: { width: 390, height: 844 } });

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

test('Ask HR answers from a policy file with a link, only once AI is on', async ({ page, browser, request }) => {
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
	await page.goto(`/t/${slug}`);
	await expect(page.getByRole('link', { name: 'Ask HR', exact: true })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Ask HR' })).toHaveCount(0);

	await page.goto(`/t/${slug}/settings/ai`);
	await page.getByLabel('Turn AI on for this company').check();
	await page.getByLabel(/text and files a feature needs are sent/).check();
	await page.getByRole('button', { name: 'Save AI settings' }).click();
	await expect(page.getByText('AI settings saved.')).toBeVisible();

	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
	const ela = await ctx.newPage();
	await signIn(ela, f.users.ela.email);
	await expect(ela.getByRole('region', { name: 'Ask HR' })).toBeVisible();
	await ela.goto(`/t/${slug}/assistant`);
	await ela.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await expect(ela.getByRole('heading', { level: 1 })).toHaveText('Ask HR');
	await expect(async () => {
		await ela.getByLabel('Your question').fill('annual leave carry over');
		await ela.getByRole('button', { name: 'Ask' }).click();
		await expect(ela.getByTestId('ask-answer').last()).toContainText('five unused days carry over', { timeout: 3000 });
	}).toPass({ timeout: 30_000 });
	const answer = ela.getByTestId('ask-answer').last();
	await expect(answer.getByRole('link', { name: 'Time off' })).toHaveAttribute('href', /\/policies\/[0-9a-f-]+\/file$/);
	await expect(ela.getByLabel('Your question')).toHaveValue('');

	await ela.getByLabel('Your question').fill('what is my balance');
	await ela.getByRole('button', { name: 'Ask' }).click();
	await expect(ela.getByTestId('ask-answer').last()).toContainText(/Fiscal year \d{4}/);
	await expect(ela.getByTestId('ask-answer').last().getByRole('link', { name: 'Leave' })).toHaveAttribute(
		'href',
		`/t/${slug}/leave`
	);
	expect(await ela.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await ctx.close();
});
