import { expect, type Page, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };
const fits = async (page: Page) =>
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

test('colleagues give kudos and discuss an announcement, and HR moderates both', async ({ browser, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'], employee: true },
			{ key: 'emp', employee: true },
			{ key: 'pal', employee: true }
		]
	});
	const slug = f.tenant!.slug;
	const pal = `pal ${slug.slice(4)}`;
	const open = async (key: string) => {
		const page = await (await browser.newContext({ viewport: PHONE })).newPage();
		await signIn(page, f.users[key].email);
		await page.waitForURL(new RegExp(`/t/${slug}`));
		return page;
	};

	const hr = await open('hr');
	await hr.goto(`/t/${slug}/kudos`);
	await hr.locator('html[data-hydrated]').waitFor();
	await hr.getByLabel(/^Values people can tag/).fill('Care\nOwnership');
	await hr.getByRole('button', { name: 'Save values' }).click();
	await expect(hr.getByRole('status')).toHaveText('Values saved.');
	await hr.goto(`/t/${slug}/announcements`);
	await hr.locator('html[data-hydrated]').waitFor();
	const create = hr.getByRole('region', { name: 'New announcement' });
	await create.getByLabel('Title').fill('Team lunch');
	await create.getByLabel('Message').fill('Thursday at noon.');
	await create.getByRole('button', { name: 'Publish' }).click();

	const emp = await open('emp');
	await emp.goto(`/t/${slug}/kudos`);
	await emp.locator('html[data-hydrated]').waitFor();
	await emp.getByLabel(/^Who to thank/).selectOption({ label: pal });
	await emp.getByRole('combobox', { name: 'Value' }).selectOption('Ownership');
	await emp.getByLabel('Message').fill('Thanks for covering my shift');
	await fits(emp);
	await emp.getByRole('button', { name: 'Send kudos' }).click();
	await expect(emp.getByRole('status')).toHaveText('Kudos sent.');
	await expect(emp.getByTestId('kudos').first()).toContainText('Thanks for covering my shift');
	await expect(emp.getByTestId('kudos-month')).toContainText('Ownership');

	await emp.goto(`/t/${slug}/announcements`);
	await emp.getByTestId('announcement-social').first().click();
	await emp.locator('html[data-hydrated]').waitFor();
	await expect(emp.getByRole('heading', { name: 'Team lunch' })).toBeVisible();
	await emp.getByRole('button', { name: /Celebrate/ }).click();
	await expect(emp.getByRole('button', { name: /Celebrate/ })).toHaveAttribute('aria-pressed', 'true');
	await emp.getByLabel('Your comment').fill('Count me in');
	await emp.getByLabel(/^Mention people/).selectOption({ label: pal });
	await emp.getByRole('button', { name: 'Post comment' }).click();
	await expect(emp.getByRole('status')).toHaveText('Comment posted.');
	await expect(emp.getByTestId('comment')).toContainText(`Mentions: ${pal}`);
	await fits(emp);

	await hr.goto(`/t/${slug}`);
	await expect(hr.getByTestId('home-kudos').first()).toContainText('Thanks for covering my shift');
	await hr.goto(`/t/${slug}/announcements`);
	await expect(hr.getByTestId('announcement-social').first()).toHaveText(/1 reaction · 1 comment/);
	await hr.getByTestId('announcement-social').first().click();
	await hr.locator('html[data-hydrated]').waitFor();
	await hr.getByTestId('comment').getByRole('button', { name: 'Hide' }).click();
	await expect(hr.getByRole('status')).toHaveText('Comment hidden.');

	await emp.reload();
	await expect(emp.getByTestId('comment')).toHaveCount(0);
	await expect(emp.getByText('No comments yet.')).toBeVisible();
});
