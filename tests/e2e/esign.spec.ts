import { expect, type Page, test } from '@playwright/test';
import { mailLink, waitForMail } from '../mailpit';
import { fixture, PASSWORD, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };
const fits = async (page: Page) =>
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

test('HR sends a PDF, an outside signer signs with an email code and staff signs after a password check', async ({
	browser,
	request
}) => {
	test.setTimeout(120_000);
	const f = await fixture(request, { tenant: {}, users: [{ key: 'own', roles: ['owner'], employee: true }] });
	const slug = f.tenant!.slug;
	const outside = `signer-${slug}@example.com`;
	const own = await (await browser.newContext({ viewport: PHONE })).newPage();
	await signIn(own, f.users.own.email);
	await own.waitForURL(new RegExp(`/t/${slug}`));
	expect((await own.goto(`/t/${slug}/signatures`))!.status()).toBe(404);

	await own.goto(`/t/${slug}/settings/modules`);
	await own.getByLabel('E-signature').check();
	await own.getByRole('button', { name: 'Save modules' }).click();
	await expect(own.getByText('Modules saved.')).toBeVisible();

	await own.goto(`/t/${slug}/signatures`);
	const create = own.getByRole('region', { name: 'New request' });
	await create.getByLabel('Title').fill('Service agreement');
	await create.getByLabel(/Document/).setInputFiles({
		name: 'agreement.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from('%PDF-1.7\nservice agreement')
	});
	await create.getByRole('button', { name: 'Create request' }).click();
	await expect(own.getByRole('heading', { level: 1 })).toHaveText('Service agreement');
	await own.locator('html[data-hydrated]').waitFor();

	const signersBox = own.getByRole('region', { name: 'Signers' });
	await signersBox.getByLabel('Someone outside').check();
	await signersBox.getByLabel('Name').fill('Outside Person');
	await signersBox.getByLabel('Email').fill(outside);
	await signersBox.getByRole('button', { name: 'Add signer' }).click();
	await expect(own.getByRole('status')).toHaveText('Signer added.');
	await own.locator('html[data-hydrated]').waitFor();
	await signersBox.getByLabel('Someone here').check();
	await signersBox.getByLabel('Person').selectOption({ index: 1 });
	await signersBox.getByRole('button', { name: 'Add signer' }).click();
	await expect(own.getByRole('status')).toHaveText('Signer added.');
	await expect(signersBox.getByTestId('signer')).toHaveCount(2);
	await own.getByRole('button', { name: 'Send for signature' }).click();
	await expect(own.getByRole('status')).toHaveText('Sent. The first signer has been asked to sign.');
	await expect(own.getByTestId('request-status')).toContainText('Waiting for signatures');
	await fits(own);

	const guest = await (await browser.newContext({ viewport: PHONE })).newPage();
	const link = new URL(mailLink((await waitForMail(outside, 15_000, 'Please sign')).text));
	await guest.goto(link.pathname);
	await expect(guest.getByRole('heading', { level: 1 })).toHaveText('Service agreement');
	await expect(guest.getByText(/SHA-256/)).toBeVisible();
	await guest.locator('html[data-hydrated]').waitFor();
	await guest.getByRole('button', { name: 'Email me a code' }).click();
	await expect(guest.getByRole('status')).toContainText('We emailed a code to s***@example.com');
	const codeMail = await waitForMail(outside, 15_000, 'Your signing code');
	const code = /\b(\d{6})\b/.exec(codeMail.text)![1];
	const sign = guest.getByRole('region', { name: 'Sign' });
	await sign.getByLabel('Code from the email').first().fill(code);
	await sign.getByLabel('Type your full name').fill('Outside Person');
	await sign.getByRole('checkbox').check();
	await sign.getByRole('button', { name: 'Sign', exact: true }).click();
	await expect(guest.getByRole('status')).toHaveText('Signed. Thank you.');
	await fits(guest);

	await own.reload();
	const mine = own.getByRole('region', { name: 'Sign' });
	await mine.getByLabel('Your password').fill(PASSWORD);
	await mine.getByRole('button', { name: 'Confirm' }).click();
	await expect(own.getByRole('status')).toContainText('Confirmed.');
	await mine.getByLabel('Type your full name').fill('Owner Person');
	await mine.getByRole('checkbox').check();
	await mine.getByRole('button', { name: 'Sign', exact: true }).click();
	await expect(own.getByRole('status')).toHaveText('Signed. Thank you.');
	await expect(own.getByTestId('request-status')).toHaveText('Signed by everyone');
	const download = own.waitForEvent('download');
	await own.getByRole('link', { name: 'Certificate of completion' }).click();
	const file = await (await download).path();
	const { readFileSync } = await import('node:fs');
	expect(readFileSync(file).subarray(0, 5).toString()).toBe('%PDF-');
	await fits(own);
});
