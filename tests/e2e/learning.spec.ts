import { expect, type Page, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };
const fits = async (page: Page) =>
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

test('HR builds and assigns a course and an employee passes it on a phone and downloads the certificate', async ({
	browser,
	request
}) => {
	test.setTimeout(120_000);
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'emp', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	const own = await (await browser.newContext({ viewport: PHONE })).newPage();
	await signIn(own, f.users.own.email);
	await own.waitForURL(new RegExp(`/t/${slug}`));
	expect((await own.goto(`/t/${slug}/learning`))!.status()).toBe(404);

	await own.goto(`/t/${slug}/settings/modules`);
	await own.getByLabel('Learning').check();
	await own.getByRole('button', { name: 'Save modules' }).click();
	await expect(own.getByText('Modules saved.')).toBeVisible();

	await own.goto(`/t/${slug}/learning`);
	const manage = own.getByRole('region', { name: 'Manage courses' });
	await manage.getByLabel('Course title').fill('Site safety');
	await manage.getByRole('button', { name: 'Create course' }).click();
	await expect(own.getByRole('heading', { level: 1 })).toHaveText('Site safety');

	const lesson = own.getByRole('region', { name: 'New lesson' });
	await lesson.getByLabel('Lesson title').fill('Read me');
	await lesson.getByLabel('Text').fill('Always wear a **helmet**.');
	await lesson.getByRole('button', { name: 'Add lesson' }).click();
	await expect(own.getByRole('status')).toHaveText('Lesson added.');
	await own.locator('html[data-hydrated]').waitFor();
	await lesson.getByLabel('Type').selectOption('quiz');
	await lesson.getByLabel('Lesson title').fill('Check');
	await lesson.getByRole('button', { name: 'Add lesson' }).click();
	await expect(own.getByRole('status')).toHaveText('Lesson added.');

	const question = own.getByRole('form', { name: 'New question for Check' });
	await question.getByLabel('Question').fill('What do you wear on site?');
	await question.getByLabel(/Options/).fill('*Helmet\nCap\nNothing');
	await question.getByRole('button', { name: 'Add question' }).click();
	await expect(own.getByRole('status')).toHaveText('Question added.');
	await own.getByRole('region', { name: 'Course settings' }).getByRole('button', { name: 'Publish' }).click();
	await expect(own.getByRole('status')).toHaveText('Status changed.');

	const assign = own.getByRole('region', { name: 'Assign' });
	await assign.getByLabel('Days to finish').fill('14');
	await assign.getByRole('button', { name: 'Assign course' }).click();
	await expect(own.getByRole('status')).toHaveText('Course assigned. 2 people were added.');
	await expect(assign.getByTestId('assignment')).toContainText('Everyone');
	await fits(own);

	const emp = await (await browser.newContext({ viewport: PHONE })).newPage();
	await signIn(emp, f.users.emp.email);
	await emp.waitForURL(new RegExp(`/t/${slug}`));
	await emp.goto(`/t/${slug}/learning`);
	const mine = emp.getByRole('region', { name: 'My courses' });
	await expect(mine.getByTestId('my-course')).toContainText('0/2 lessons');
	await expect(mine.getByTestId('my-course')).toContainText('required');
	await fits(emp);
	await mine.getByRole('link', { name: 'Site safety' }).click();
	await expect(emp.locator('.markdown strong')).toHaveText('helmet');
	await expect(emp.getByRole('region', { name: 'Course settings' })).toHaveCount(0);
	expect(await emp.content()).not.toMatch(/answerIds|answer_ids/);

	await emp.getByRole('listitem', { name: 'Lesson 1' }).getByRole('button', { name: 'Mark as done' }).click();
	await expect(emp.getByRole('status')).toHaveText('Lesson done.');
	const quiz = emp.getByRole('listitem', { name: 'Lesson 2' });
	await quiz.getByLabel('Cap').check();
	await quiz.getByRole('button', { name: 'Submit answers' }).click();
	await expect(emp.getByRole('alert')).toHaveText('You scored 0%. 2 attempts left.');
	await quiz.getByLabel('Helmet').check();
	await quiz.getByRole('button', { name: 'Submit answers' }).click();
	await expect(emp.getByRole('status')).toHaveText('You scored 100%. Quiz passed.');

	const progress = emp.getByRole('region', { name: 'My progress' });
	await expect(progress).toContainText('Passed with 100%.');
	const href = await progress.getByRole('link', { name: 'Download certificate' }).getAttribute('href');
	const pdf = await emp.request.get(href!);
	expect(pdf.status()).toBe(200);
	expect(pdf.headers()['content-type']).toBe('application/pdf');
	expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
	await fits(emp);

	await own.goto(`/t/${slug}/learning/report`);
	await expect(own.getByTestId('course-row')).toContainText('Site safety');
	await fits(own);
});
