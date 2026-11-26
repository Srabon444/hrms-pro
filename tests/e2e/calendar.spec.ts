import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test('managers post events, staff answer them and see them on the team calendar and in their calendar app', async ({
	page,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'staff', roles: ['employee'], employee: true }
		]
	});
	const t = `/t/${f.tenant!.slug}`;
	const day = ahead(10);
	const nav = page.getByRole('navigation', { name: 'Main' });

	await signIn(page, f.users.own.email);
	await nav.getByRole('link', { name: 'Events' }).click();
	await expect(page).toHaveURL(`${t}/events`);
	const create = page.getByRole('region', { name: 'New event' });
	await create.getByLabel('Title').fill('Quarterly town hall');
	await create.getByLabel('Location (optional)').fill('Main hall');
	await create.getByLabel('Starts on').fill(day);
	await create.getByLabel(/^Start time/).fill('10:00');
	await create.getByLabel('End time').fill('11:30');
	await create.getByRole('button', { name: 'Add event' }).click();
	await expect(page.getByTestId('event').filter({ hasText: 'Quarterly town hall' })).toContainText('10:00–11:30');

	await page.context().clearCookies();
	await signIn(page, f.users.staff.email);
	await expect(nav.getByRole('link', { name: 'Calendar' })).toBeVisible();
	await page.goto(`${t}/events`);
	await expect(page.getByRole('region', { name: 'New event' })).toHaveCount(0);
	const card = page.getByTestId('event').filter({ hasText: 'Quarterly town hall' });
	await card.getByRole('button', { name: 'Going', exact: true }).click();
	await expect(card).toContainText('1 going · You: Going');

	await page.goto(`${t}/calendar?month=${day.slice(0, 7)}`);
	await expect(page.locator(`[data-testid="day"][data-date="${day}"]`)).toContainText('10:00 Quarterly town hall');
	await page.getByRole('button', { name: 'Create link' }).click();
	const link = new URL(await page.getByTestId('feed-url').inputValue()).pathname;
	const ics = await page.request.get(link);
	expect(ics.status()).toBe(200);
	expect(ics.headers()['content-type']).toBe('text/calendar; charset=utf-8');
	expect(ics.headers()['referrer-policy']).toBe('no-referrer');
	expect(await ics.text()).toContain('SUMMARY:Quarterly town hall');
	await page.goto(`${t}/calendar`);
	await expect(page.getByTestId('feed-status')).toContainText('is on');
	await page.getByRole('button', { name: 'Replace link' }).click();
	await expect(page.getByTestId('feed-url')).toBeVisible();
	expect((await page.request.get(link)).status()).toBe(404);

	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto(`${t}/calendar?month=${day.slice(0, 7)}`);
	await expect(page.getByTestId('month-grid')).toBeHidden();
	await expect(page.getByTestId('agenda')).toContainText('Quarterly town hall');
	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width).toBeLessThanOrEqual(390);
	await page.setViewportSize({ width: 1280, height: 800 });

	await page.context().clearCookies();
	await signIn(page, f.users.own.email);
	await page.goto(`${t}/settings/modules`);
	await page.getByLabel('Team calendar').uncheck();
	await page.getByRole('button', { name: 'Save modules' }).click();
	await expect(page.getByText('Modules saved.')).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Calendar' })).toHaveCount(0);
	expect((await page.goto(`${t}/calendar`))?.status()).toBe(404);
	const origin = new URL(page.url()).origin;
	expect((await page.request.post(`${t}/calendar?/issueFeed`, { headers: { origin }, form: {} })).status()).toBe(404);
	await page.goto(`${t}/settings/modules`);
	await page.getByRole('checkbox', { name: /^Events/ }).uncheck();
	await page.getByRole('button', { name: 'Save modules' }).click();
	await expect(page.getByText('Modules saved.')).toBeVisible();
	expect((await page.goto(`${t}/events`))?.status()).toBe(404);
	expect(
		(
			await page.request.post(`${t}/events?/rsvp`, {
				headers: { origin },
				form: { eventId: crypto.randomUUID(), response: 'yes' }
			})
		).status()
	).toBe(404);
});
