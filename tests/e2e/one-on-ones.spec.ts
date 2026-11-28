import { expect, type Page, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };
const fits = async (page: Page) =>
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

test('an employee and their manager hold a 1:1 with private notes, and a colleague gives feedback', async ({
	browser,
	request
}) => {
	test.setTimeout(90_000);
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'mgr', roles: ['line_manager'], employee: true },
			{ key: 'emp', employee: true, manager: 'mgr' },
			{ key: 'pal', employee: true }
		]
	});
	const slug = f.tenant!.slug;
	const run = slug.slice(4);
	const open = async (key: string) => {
		const page = await (await browser.newContext({ viewport: PHONE })).newPage();
		await signIn(page, f.users[key].email);
		await page.waitForURL(new RegExp(`/t/${slug}`));
		return page;
	};

	const own = await open('own');
	await own.goto(`/t/${slug}/settings/modules`);
	await own.getByLabel('1:1s and feedback').check();
	await own.getByRole('button', { name: 'Save modules' }).click();
	await expect(own.getByText('Modules saved.')).toBeVisible();

	const emp = await open('emp');
	await emp.goto(`/t/${slug}/one-on-ones`);
	await emp.locator('html[data-hydrated]').waitFor();
	await emp.getByRole('combobox', { name: 'With' }).selectOption({ label: `mgr ${run} (my manager)` });
	await emp.getByLabel('Date', { exact: true }).fill('2026-12-01');
	await emp.getByRole('button', { name: 'Schedule' }).click();
	await expect(emp.getByRole('heading', { name: `mgr ${run} and emp ${run}` })).toBeVisible();
	await emp.locator('html[data-hydrated]').waitFor();
	await emp.getByLabel('Item', { exact: true }).fill('Career plan');
	await emp.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(emp.getByRole('status')).toHaveText('Item added.');
	await emp.getByRole('combobox', { name: 'Type' }).selectOption('action');
	await emp.getByLabel('Item', { exact: true }).fill('Book the course');
	await emp.getByRole('combobox', { name: 'Owner' }).selectOption({ label: `emp ${run}` });
	await emp.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(emp.getByTestId('item')).toHaveCount(2);
	await emp.getByLabel('My note').fill('Ask about a raise');
	await emp.getByRole('button', { name: 'Save note' }).click();
	await expect(emp.getByRole('status')).toHaveText('Private note saved.');
	await fits(emp);

	const mgr = await open('mgr');
	await mgr.goto(`/t/${slug}/one-on-ones`);
	await mgr.getByTestId('one-on-one').first().click();
	await mgr.locator('html[data-hydrated]').waitFor();
	await expect(mgr.getByRole('region', { name: 'Agenda' })).toContainText('Career plan');
	await expect(mgr.getByRole('region', { name: 'Actions' })).toContainText(`Book the course`);
	await expect(mgr.getByLabel('My note')).toHaveValue('');
	await mgr.getByRole('button', { name: 'Mark done' }).click();
	await expect(mgr.getByRole('status')).toHaveText('1:1 marked done.');
	await fits(mgr);

	const pal = await open('pal');
	await pal.goto(`/t/${slug}/feedback`);
	await pal.locator('html[data-hydrated]').waitFor();
	await pal.getByRole('combobox', { name: 'About' }).selectOption({ label: `emp ${run}` });
	await pal.getByLabel('Feedback', { exact: true }).fill('Great demo today');
	await pal.getByRole('button', { name: 'Send feedback' }).click();
	await expect(pal.getByRole('status')).toHaveText('Feedback sent.');
	await fits(pal);

	await emp.goto(`/t/${slug}/feedback`);
	await expect(emp.getByTestId('feedback-received')).toContainText('Great demo today');
	await fits(emp);
});
