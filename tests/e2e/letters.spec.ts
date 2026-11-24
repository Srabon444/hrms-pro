import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR edits a template, issues a salary certificate and the employee downloads it', async ({ page, browser }) => {
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
	await page.getByRole('link', { name: 'Letter templates', exact: true }).click();
	await expect(page.getByTestId('letter-template')).toHaveCount(6);
	await page.getByRole('link', { name: 'Salary certificate' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Salary certificate');
	const body = page.getByLabel('Body');
	await body.fill(`${await body.inputValue()}\n{{employee.shoe_size}}`);
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('alert')).toHaveText('Use only the placeholders listed under the editor.');
	await body.fill('To whom it may concern,\n\n{{employee.name}} draws BDT {{salary.gross}} a month.');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByTestId('letter-template')).toHaveCount(6);

	await page.getByRole('link', { name: 'Letters', exact: true }).click();
	const issue = page.getByRole('region', { name: 'Issue a letter' });
	const person = issue.getByLabel('Employee');
	await person.selectOption((await person.locator('option', { hasText: 'ela' }).getAttribute('value'))!);
	await issue.getByLabel('Template').selectOption({ label: 'Salary certificate' });
	await issue.getByRole('button', { name: 'Prepare letter' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Salary certificate for');
	const letter = page.getByLabel('Letter');
	await expect(letter).toHaveValue(/draws BDT \{\{salary\.gross\}\} a month/);
	await page.getByRole('button', { name: 'Issue letter' }).click();
	await expect(page.getByRole('alert')).toHaveText('Fill in every {{placeholder}} before issuing.');
	await letter.fill((await letter.inputValue()).replace('{{salary.gross}}', '50,000'));
	await page.getByRole('button', { name: 'Issue letter' }).click();
	await expect(page.getByTestId('issued-letter')).toHaveCount(1);
	await expect(page.getByTestId('issued-letter')).toContainText('L-00001');
	await expect(page.getByRole('region', { name: 'My letters' })).toContainText('No letters yet.');

	const ctx = await browser.newContext();
	const ela = await ctx.newPage();
	await signIn(ela, f.users.ela.email);
	await expect(ela).toHaveURL(/\/t\//);
	await ela.getByRole('link', { name: 'Letters', exact: true }).click();
	await expect(ela.getByRole('region', { name: 'Issue a letter' })).toHaveCount(0);
	await expect(ela.getByRole('link', { name: 'Letter templates' })).toHaveCount(0);
	await expect(ela.getByTestId('my-letter')).toHaveCount(1);
	const href = await ela.getByTestId('my-letter').getByRole('link').getAttribute('href');
	const res = await ela.request.get(href!);
	expect(res.status()).toBe(200);
	expect(res.headers()['content-disposition']).toContain('attachment');
	expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
	expect((await ela.request.get(`/t/${slug}/settings/letters`)).status()).toBe(403);
	await ctx.close();
});
