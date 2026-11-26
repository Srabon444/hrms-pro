import { expect, test, type Page } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const box = (page: Page) => page.getByRole('combobox', { name: 'Find pages and records' });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Quick find' });

async function home(page: Page, slug: string) {
	await page.waitForURL(new RegExp(`/t/${slug}$`));
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await expect(page.getByRole('button', { name: /^Search/ })).toBeVisible();
}

async function team(request: Parameters<typeof fixture>[0]) {
	return fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'ana', roles: ['employee'], employee: true, manager: 'own' },
			{ key: 'bob', roles: ['employee'], employee: true, manager: 'own' }
		]
	});
}

test('Ctrl+K finds a settings page, opens it and remembers it until sign out', async ({ page, request }) => {
	const f = await team(request);
	const t = `/t/${f.tenant!.slug}`;
	await signIn(page, f.users.own.email);
	await home(page, f.tenant!.slug);

	await page.keyboard.press('Control+k');
	await expect(dialog(page)).toBeVisible();
	await box(page).fill('audit');
	await expect(page.getByRole('option', { name: /Audit log/ })).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Enter');
	await page.waitForURL(`${t}/settings/audit`);
	await expect(dialog(page)).toBeHidden();

	await page.keyboard.press('Control+k');
	await expect(page.getByRole('group', { name: 'Recent' }).getByRole('option', { name: /Audit log/ })).toBeVisible();
	await page.keyboard.press('Escape');

	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.waitForURL(/\/login/);
	expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hrms.recent.')))).toEqual([]);
});

test('an employee code typed after / opens the profile using only the keyboard', async ({ page, request }) => {
	const f = await team(request);
	const t = `/t/${f.tenant!.slug}`;
	await signIn(page, f.users.own.email);
	await home(page, f.tenant!.slug);

	await page.keyboard.press('/');
	await expect(box(page)).toBeFocused();
	await box(page).pressSequentially('e2e-ana');
	const people = page.getByRole('group', { name: 'People' });
	await expect(people.getByRole('option', { name: /E2E-ANA/ })).toBeVisible();
	await expect(people.getByRole('option')).toHaveCount(1);
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowUp');
	await page.keyboard.press('Enter');
	await page.waitForURL(`${t}/employees/${f.users.ana.employeeId}`);
});

test('an employee neither finds a colleague nor sees pages they cannot open', async ({ page, request }) => {
	const f = await team(request);
	await signIn(page, f.users.ana.email);
	await home(page, f.tenant!.slug);

	await page.getByRole('button', { name: /^Search/ }).click();
	await box(page).fill('E2E-BOB');
	await expect(page.getByText('No matches.')).toBeVisible();
	await box(page).fill('audit');
	await expect(page.getByText('No matches.')).toBeVisible();
	await box(page).fill('leave');
	await expect(page.getByRole('option', { name: /^Leave/ }).first()).toBeVisible();
});

test('the / shortcut can be switched off', async ({ page, request }) => {
	const f = await team(request);
	await signIn(page, f.users.own.email);
	await home(page, f.tenant!.slug);

	await page.keyboard.press('Control+k');
	await page.getByLabel('Open with /').uncheck();
	await page.keyboard.press('Escape');
	await page.keyboard.press('/');
	await expect(dialog(page)).toBeHidden();
	await page.keyboard.press('Control+k');
	await expect(dialog(page)).toBeVisible();
});

test('opens with broken saved recents and never offers the previous query results', async ({ page, request }) => {
	const f = await team(request);
	await signIn(page, f.users.own.email);
	await home(page, f.tenant!.slug);
	await page.evaluate((key) => localStorage.setItem(key, '{bad'), `hrms.recent.${f.users.own.id}`);

	await page.keyboard.press('Control+k');
	await expect(dialog(page)).toBeVisible();
	await box(page).fill('e2e-ana');
	await expect(page.getByRole('option', { name: /E2E-ANA/ })).toBeVisible();
	await page.route('**/search?q=*', (route) => route.fulfill({ status: 429, body: 'Too many requests' }));
	await box(page).fill('e2e-anb');
	await expect(page.getByText('Too many searches. Wait a moment.')).toBeVisible();
	await expect(page.getByRole('option', { name: /E2E-ANA/ })).toHaveCount(0);
});

test.describe('phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the search button opens a box that fits the screen', async ({ page, request }) => {
		const f = await team(request);
		await signIn(page, f.users.own.email);
		await home(page, f.tenant!.slug);

		await page.getByRole('button', { name: /^Search/ }).click();
		await box(page).fill('employees');
		await expect(page.getByRole('option', { name: /^Employees/ })).toBeVisible();
		const rect = await dialog(page).boundingBox();
		expect(rect!.x).toBeGreaterThanOrEqual(0);
		expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	});
});
