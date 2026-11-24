import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test.use({ viewport: { width: 390, height: 844 } });

test('on a phone the menu folds away, tables stack into labelled rows and nothing scrolls sideways', async ({
	page,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'ana', roles: ['employee'], employee: true, manager: 'own' }
		]
	});
	const t = `/t/${f.tenant!.slug}`;
	await signIn(page, f.users.own.email);
	await page.waitForURL(new RegExp(`${t}$`));

	const nav = page.getByRole('navigation', { name: 'Main' });
	await expect(nav).toBeHidden();
	await page.getByRole('button', { name: 'Menu' }).click();
	await expect(nav).toBeVisible();
	await nav.getByRole('link', { name: 'Employees' }).click();
	await page.waitForURL(`${t}/employees`);
	await expect(nav).toBeHidden();

	const nameCell = page.getByRole('cell', { name: `ana ${f.tenant!.slug.slice(4)}` });
	await expect(nameCell).toHaveAttribute('data-label', 'Name');

	for (const path of [
		'',
		'/employees',
		'/settings/users',
		'/settings/audit',
		'/payroll',
		'/meals/bills',
		'/reports/headcount'
	]) {
		await page.goto(`${t}${path}`);
		await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
		const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(wide, `${path || '/'} scrolls sideways`).toBeLessThanOrEqual(0);
	}
});
