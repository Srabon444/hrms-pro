import { expect, type Page, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };
const fits = async (page: Page) =>
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

test('HR posts an internal job, an employee with a validated skill applies and a colleague refers a friend', async ({
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
	await own.getByLabel('Skills and internal jobs').check();
	await own.getByRole('button', { name: 'Save modules' }).click();
	await expect(own.getByText('Modules saved.')).toBeVisible();

	await own.goto(`/t/${slug}/skills`);
	await own.locator('html[data-hydrated]').waitFor();
	await own.getByLabel('New skill').fill('Svelte');
	await own.getByRole('button', { name: 'Add skill' }).click();
	await expect(own.getByRole('status')).toHaveText('Skill added to the catalogue.');
	await fits(own);

	await own.goto(`/t/${slug}/recruitment`);
	const create = own.getByRole('region', { name: 'New opening' });
	await create.getByLabel('Job title').fill('Frontend engineer');
	await create.getByRole('button', { name: 'Open position' }).click();
	await expect(own.getByRole('heading', { name: 'Frontend engineer · Open' })).toBeVisible();
	await own.locator('html[data-hydrated]').waitFor();
	const edit = own.getByRole('region', { name: 'Edit opening' });
	await edit.getByRole('combobox', { name: 'Who can see it' }).selectOption('internal');
	await edit.getByLabel('Referral bonus').fill('1000');
	await edit.getByRole('listbox', { name: 'Skills wanted' }).selectOption({ label: 'Svelte' });
	await edit.getByLabel('Description').fill('We build **fast** apps.\n\n<script>alert(1)</script>');
	await edit.getByRole('button', { name: 'Save opening' }).click();
	await expect(own.getByRole('status')).toHaveText('Opening saved.');

	const emp = await open('emp');
	await emp.goto(`/t/${slug}/skills`);
	await emp.locator('html[data-hydrated]').waitFor();
	await emp.getByRole('combobox', { name: 'Skill', exact: true }).selectOption({ label: 'Svelte' });
	await emp.getByRole('combobox', { name: 'Level' }).selectOption('4');
	await emp.getByRole('button', { name: 'Save skill' }).click();
	await expect(emp.getByTestId('my-skill')).toContainText('Svelte · level 4 · Waiting for validation');
	await fits(emp);

	const mgr = await open('mgr');
	await mgr.goto(`/t/${slug}/skills`);
	await expect(mgr.getByTestId('pending-skill')).toContainText(`emp ${run} · Svelte · level 4`);
	await mgr.getByRole('button', { name: 'Validate' }).click();
	await expect(mgr.getByRole('status')).toHaveText('Skill validated.');
	await fits(mgr);

	await emp.goto(`/t/${slug}/jobs`);
	await emp.locator('html[data-hydrated]').waitFor();
	const job = emp.getByTestId('job');
	await expect(job).toContainText('100% skill match');
	await expect(job.locator('strong')).toHaveText('fast');
	await expect(job.locator('script')).toHaveCount(0);
	await expect(job).toContainText('<script>alert(1)</script>');
	await job.getByLabel('Tell my manager I applied').check();
	await job.getByRole('button', { name: 'Apply' }).click();
	await expect(emp.getByRole('status')).toHaveText('Application sent to the hiring team.');
	await expect(emp.getByTestId('application')).toContainText('Frontend engineer · Applied');
	await fits(emp);

	const pal = await open('pal');
	await pal.goto(`/t/${slug}/jobs`);
	await pal.locator('html[data-hydrated]').waitFor();
	await pal.getByText('Refer someone').click();
	await pal.getByLabel('Name', { exact: true }).fill('Rafi Ahmed');
	await pal.getByLabel('Email', { exact: true }).fill(`rafi-${run}@example.com`);
	await pal.getByRole('button', { name: 'Send referral' }).click();
	await expect(pal.getByRole('status')).toHaveText('Referral sent to the hiring team.');
	await expect(pal.getByTestId('referral')).toContainText('Rafi Ahmed · Frontend engineer · Applied');
	await fits(pal);

	await own.reload();
	await expect(own.getByRole('region', { name: 'Pipeline' })).toContainText(`emp ${run}`);
	await expect(own.getByRole('region', { name: 'Pipeline' })).toContainText('Rafi Ahmed');
	await fits(own);
});
