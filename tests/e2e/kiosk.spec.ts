import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };

test('HR pairs a kiosk, staff set a PIN and punch at the kiosk, and a switched-off kiosk stops working', async ({
	page,
	browser,
	request
}) => {
	test.setTimeout(90_000);
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'ana', roles: ['employee'], employee: true }
		]
	});
	const t = `/t/${f.tenant!.slug}`;
	await signIn(page, f.users.own.email);
	await page.goto(`${t}/settings/modules`);
	await page.getByLabel('Attendance kiosk').check();
	await page.getByRole('button', { name: 'Save modules' }).click();
	await expect(page.getByText('Modules saved.')).toBeVisible();

	await page.goto(`${t}/settings/work-sites`);
	const site = page.getByRole('region', { name: 'New work site' });
	await site.getByLabel('Name').fill('HQ');
	await site.getByLabel('Latitude').fill('23.7808');
	await site.getByLabel('Longitude').fill('90.4074');
	await site.getByRole('button', { name: 'Add site' }).click();
	await expect(page.getByRole('status')).toHaveText('Work sites saved.');

	await page.goto(`${t}/settings`);
	await page.getByRole('link', { name: 'Kiosks' }).first().click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kiosks');
	const add = page.getByRole('region', { name: 'New kiosk' });
	await add.getByLabel('Name').fill('Front desk');
	await add.getByLabel('Work site').selectOption({ label: 'HQ' });
	await add.getByRole('button', { name: 'Add kiosk' }).click();
	await expect(page.getByRole('status')).toHaveText('Kiosks saved.');
	const desk = page.getByRole('region', { name: 'Front desk' });
	await expect(desk.getByTestId('kiosk-state')).toHaveText('HQ · Not paired');
	await desk.getByRole('button', { name: 'New pairing link' }).click();
	const link = await desk.getByLabel(/^Pairing link/).inputValue();
	expect(link).toMatch(/\/kiosk\/pair#[A-Za-z0-9_-]{43}$/);

	const phone = await browser.newContext({ viewport: PHONE });
	const ana = await phone.newPage();
	await signIn(ana, f.users.ana.email);
	await ana.goto(`${t}/attendance`);
	const pinBox = ana.getByRole('region', { name: 'Kiosk PIN' });
	await pinBox.getByLabel('New PIN (6 to 8 digits)').fill('123456');
	await pinBox.getByLabel('Type it again').fill('123456');
	await pinBox.getByRole('button', { name: 'Save PIN' }).click();
	await expect(ana.getByRole('alert')).toHaveText(/not a run, a repeat/);
	await pinBox.getByLabel('New PIN (6 to 8 digits)').fill('482915');
	await pinBox.getByLabel('Type it again').fill('482915');
	await pinBox.getByRole('button', { name: 'Save PIN' }).click();
	await expect(ana.getByRole('status')).toHaveText('Kiosk PIN saved.');
	await expect(pinBox.getByTestId('kiosk-pin-state')).toHaveText(/You have a kiosk PIN/);
	expect(await ana.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

	const tablet = await browser.newContext({ viewport: PHONE });
	const kiosk = await tablet.newPage();
	const path = new URL(link);
	await kiosk.goto(`${path.pathname}${path.hash}`);
	await kiosk.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await expect(kiosk).toHaveURL(/\/kiosk\/pair$/);
	await kiosk.getByRole('button', { name: 'Set up kiosk' }).click();
	await expect(kiosk.getByRole('status')).toHaveText('This browser is now a kiosk.');
	await kiosk.getByRole('link', { name: 'Open the kiosk' }).click();
	await kiosk.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await expect(kiosk.getByText('Front desk · HQ')).toBeVisible();
	await kiosk.getByLabel('Employee code').fill('E2E-ANA');
	await kiosk.getByLabel('PIN').fill('111222');
	await kiosk.getByRole('button', { name: 'Punch in or out' }).click();
	await expect(kiosk.getByRole('alert')).toHaveText('That employee code and PIN do not match.');
	await tablet.setExtraHTTPHeaders({ 'x-test-now': '2026-11-24T09:05:00+06:00' });
	await kiosk.getByLabel('PIN').fill('482915');
	await kiosk.getByRole('button', { name: 'Punch in or out' }).click();
	await expect(kiosk.getByRole('status')).toHaveText(/^Punch recorded, ana\. 09:05$/);
	await expect(kiosk.getByLabel('Employee code')).toHaveValue('');
	await expect(kiosk.getByLabel('PIN')).toHaveValue('');
	expect(await kiosk.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

	await page.setExtraHTTPHeaders({ 'x-test-now': '2026-11-24T19:00:00+06:00' });
	await page.goto(`${t}/attendance?date=2026-11-24`);
	await expect(
		page.getByRole('region', { name: 'Team' }).getByTestId('team-day').filter({ hasText: /^ana/ })
	).toContainText('09:05');

	await page.goto(`${t}/settings/kiosks`);
	await expect(desk.getByTestId('kiosk-state')).toContainText('Paired');
	await desk.getByRole('button', { name: 'Switch off' }).click();
	await expect(page.getByRole('status')).toHaveText(/Kiosk switched off/);
	await kiosk.reload();
	await expect(kiosk.getByText('This browser is not set up as a kiosk.')).toBeVisible();
	await phone.close();
	await tablet.close();
});
