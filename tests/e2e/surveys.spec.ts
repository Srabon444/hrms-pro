import { expect, type Page, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };
const fits = async (page: Page) =>
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

test('HR runs a named survey, an employee answers it and sends an anonymous suggestion', async ({
	browser,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'], employee: true },
			{ key: 'emp', employee: true }
		]
	});
	const slug = f.tenant!.slug;
	const hr = await (await browser.newContext({ viewport: PHONE })).newPage();
	await signIn(hr, f.users.hr.email);
	await hr.goto(`/t/${slug}/surveys/new`);
	await hr.locator('html[data-hydrated]').waitFor();
	await hr.getByLabel('Title').fill('Team pulse');
	await hr.getByLabel('Closes on').fill('2099-12-31');
	await hr.getByRole('checkbox', { name: /^Anonymous/ }).uncheck();
	await hr.getByRole('button', { name: 'Add question' }).click();
	await hr.getByLabel('Question 2 type').selectOption('text');
	await hr.getByLabel('Question 2', { exact: true }).fill('What should we change?');
	await fits(hr);
	await expect(hr.getByRole('checkbox', { name: /^Anonymous/ })).not.toBeChecked();
	await hr.getByRole('button', { name: 'Save as draft' }).click();
	await expect(hr.getByTestId('survey-state')).toHaveText(/^Draft · Names recorded/);
	await hr.getByRole('button', { name: 'Open survey' }).click();
	await expect(hr.getByRole('status')).toHaveText('The survey is open and everyone asked was told.');

	const emp = await (await browser.newContext({ viewport: PHONE })).newPage();
	await signIn(emp, f.users.emp.email);
	await emp.goto(`/t/${slug}/surveys`);
	await emp.locator('html[data-hydrated]').waitFor();
	await emp.getByRole('link', { name: 'Answer Team pulse' }).click();
	const form = emp.getByRole('form', { name: 'Your answers' });
	await form.getByTestId('answer').first().getByLabel('9').check();
	await form.getByLabel('What should we change?').fill('More pairing time');
	await fits(emp);
	await form.getByRole('button', { name: 'Send answers' }).click();
	await expect(emp.getByRole('status')).toHaveText('Thank you. Your answers were saved.');
	await expect(emp.getByText('You answered this survey. Thank you.')).toBeVisible();

	await emp.goto(`/t/${slug}/surveys`);
	await emp.locator('html[data-hydrated]').waitFor();
	await emp.getByLabel('Your suggestion').fill('A quiet room please');
	await emp.getByRole('button', { name: 'Send suggestion' }).click();
	await expect(emp.getByRole('status')).toHaveText('Thank you. Your suggestion was sent without your name.');
	await expect(emp.getByRole('link', { name: 'New survey' })).toHaveCount(0);

	await hr.reload();
	const results = hr.getByRole('region', { name: 'Results' });
	await expect(results.getByTestId('result-summary').first()).toHaveText(/^1 answers · eNPS 100 /);
	await expect(results.getByText('More pairing time')).toBeVisible();
	await expect(results.getByText(/^emp \S+$/)).toBeVisible();
	await hr.getByRole('button', { name: 'Close survey' }).click();
	await expect(hr.getByTestId('survey-state')).toHaveText(/^Closed/);
	await fits(hr);

	await hr.goto(`/t/${slug}/surveys/suggestions`);
	await expect(hr.getByTestId('suggestion')).toHaveCount(0);
	await expect(hr.getByText('No suggestions to show yet.')).toBeVisible();
	await fits(hr);
});
