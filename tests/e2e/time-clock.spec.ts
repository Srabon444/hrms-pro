import { expect, test, type Browser } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const DAY = '2026-11-24';
const HQ = { latitude: 23.7808, longitude: 90.4074 };

async function phone(browser: Browser, email: string, where: { latitude: number; longitude: number }) {
	const ctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		permissions: ['geolocation'],
		geolocation: { ...where, accuracy: 15 }
	});
	const page = await ctx.newPage();
	await signIn(page, email);
	const clock = (time: string) => ctx.setExtraHTTPHeaders({ 'x-test-now': `${DAY}T${time}:00+06:00` });
	return { ctx, page, clock };
}

test('HR sets a work site; punches away from it are blocked or flagged, and breaks come off the day', async ({
	page,
	browser,
	request
}) => {
	test.setTimeout(90_000);
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'], employee: true },
			{ key: 'ana', roles: ['employee'], employee: true },
			{ key: 'bea', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${slug}/settings`);
	await page.getByRole('link', { name: 'Work sites' }).first().click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Work sites');
	const add = page.getByRole('region', { name: 'New work site' });
	await add.getByLabel('Name').fill('HQ');
	await add.getByLabel('Latitude').fill(String(HQ.latitude));
	await add.getByLabel('Longitude').fill(String(HQ.longitude));
	await add.getByLabel('Radius (metres)').fill('300');
	await add.getByRole('button', { name: 'Add site' }).click();
	await expect(page.getByRole('status')).toHaveText('Work sites saved.');
	await expect(page.getByRole('region', { name: 'HQ' })).toBeVisible();
	const rule = page.getByRole('region', { name: 'Punch rule' });
	await rule.getByLabel('Punches away from a work site').selectOption('block');
	await rule.getByRole('button', { name: 'Save rule' }).click();
	await expect(page.getByRole('status')).toHaveText('Work sites saved.');

	await page.goto(`/t/${slug}/settings/shifts`);
	const general = page.getByRole('region', { name: 'General' });
	await general.getByLabel('Break (minutes)').fill('30');
	await general.getByRole('checkbox', { name: /^Break is paid/ }).setChecked(false);
	await general.getByRole('button', { name: 'Save General' }).click();
	await expect(page.getByRole('status')).toHaveText('Shifts saved.');

	const ana = await phone(browser, f.users.ana.email, { latitude: 0, longitude: 0 });
	await ana.clock('09:00');
	await ana.page.goto(`/t/${slug}/attendance`);
	await ana.page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	const anaToday = ana.page.getByRole('region', { name: 'Today' });
	await expect(anaToday).toContainText('Your location is checked');
	await anaToday.getByRole('button', { name: 'Punch in' }).click();
	await expect(ana.page.getByRole('alert')).toHaveText(/You are not at a work site/);
	await expect(anaToday.getByTestId('punch')).toHaveCount(0);

	const bea = await phone(browser, f.users.bea.email, HQ);
	const beaToday = bea.page.getByRole('region', { name: 'Today' });
	const tap = async (time: string, button: string) => {
		const before = await beaToday.getByTestId('punch').count();
		await bea.clock(time);
		await beaToday.getByRole('button', { name: button }).click();
		await expect(beaToday.getByTestId('punch')).toHaveCount(before + 1);
		await expect(bea.page.getByRole('status')).toHaveText('Punch recorded.');
	};
	await bea.clock('09:00');
	await bea.page.goto(`/t/${slug}/attendance`);
	await bea.page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await expect(beaToday.getByRole('button', { name: 'Start break' })).toHaveCount(0);
	await tap('09:00', 'Punch in');
	await tap('13:00', 'Start break');
	await expect(beaToday.getByTestId('on-break')).toBeVisible();
	await expect(beaToday.getByRole('button', { name: 'Punch out' })).toHaveCount(0);
	await tap('13:30', 'End break');
	await tap('18:00', 'Punch out');
	await expect(beaToday.getByTestId('punch')).toHaveText(['09:00', '13:00 break', '13:30 back', '18:00']);
	await expect(beaToday.getByTestId('today-status')).toHaveText('Present · 8h 30m');
	expect(await bea.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

	await page.goto(`/t/${slug}/settings/work-sites`);
	await rule.getByLabel('Punches away from a work site').selectOption('flag');
	await rule.getByRole('button', { name: 'Save rule' }).click();
	await expect(page.getByRole('status')).toHaveText('Work sites saved.');
	await ana.page.reload();
	await anaToday.getByRole('button', { name: 'Punch in' }).click();
	await expect(ana.page.getByRole('status')).toHaveText(/away from a work site, so HR can see it/);
	await expect(anaToday.getByTestId('punch')).toHaveText(['09:00 · away from site']);

	await page.setExtraHTTPHeaders({ 'x-test-now': `${DAY}T19:00:00+06:00` });
	await page.goto(`/t/${slug}/attendance?date=${DAY}`);
	const team = page.getByRole('region', { name: 'Team' });
	await expect(team.getByTestId('team-day').filter({ hasText: /^ana/ }).getByTestId('away-flag')).toBeVisible();
	await expect(team.getByTestId('team-day').filter({ hasText: /^bea/ }).getByTestId('away-flag')).toHaveCount(0);
	await ana.ctx.close();
	await bea.ctx.close();
});
