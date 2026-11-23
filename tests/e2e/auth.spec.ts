import { expect, test } from '@playwright/test';
import { base32Decode, hotp, newTotpSecret, timeStep } from '../../src/lib/server/auth/totp';
import { mailLink, waitForMail } from '../mailpit';
import { PASSWORD, fixture, signIn } from './fixtures';

test('member signs in to their organisation, cannot open another one, and signs out', async ({ page, request }) => {
	const a = await fixture(request, { tenant: {}, users: [{ key: 'staff' }] });
	const b = await fixture(request, { tenant: {}, users: [] });
	await signIn(page, a.users.staff.email);
	await expect(page).toHaveURL(`/t/${a.tenant!.slug}`);
	await expect(page.getByRole('heading', { name: `Welcome to ${a.tenant!.name}` })).toBeVisible();

	const other = await page.goto(`/t/${b.tenant!.slug}`);
	expect(other?.status()).toBe(404);

	await page.goto(`/t/${a.tenant!.slug}`);
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login\?notice=signedout/);
	await page.goto(`/t/${a.tenant!.slug}`);
	await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Ft%2F${a.tenant!.slug}`));
});

test('wrong passwords are rejected and the address is blocked after five failures', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'victim' }] });
	const waits = [0, 0, 1100, 2100, 0];
	for (const wait of waits) {
		await signIn(page, f.users.victim.email, 'not the right password');
		await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
		await page.waitForTimeout(wait);
	}
	await signIn(page, f.users.victim.email);
	await expect(page.getByRole('alert')).toContainText('Too many attempts');
});

test('user turns on two-factor and must use it on the next sign-in', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'tfa' }] });
	await signIn(page, f.users.tfa.email);
	await page.goto('/account/security');
	await page.getByRole('button', { name: 'Set up' }).click();
	const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
	const key = base32Decode(secret);
	await page.getByLabel('Code').fill(hotp(key, timeStep(new Date())));
	await page.getByRole('button', { name: 'Turn on' }).click();
	await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);

	await page.goto('/');
	await page.getByRole('button', { name: 'Sign out' }).click();
	await signIn(page, f.users.tfa.email);
	await expect(page).toHaveURL(/\/login\/verify/);
	await page.getByLabel('Code').fill(hotp(key, timeStep(new Date()) + 1));
	await page.getByRole('button', { name: 'Verify' }).click();
	await expect(page).toHaveURL(`/t/${f.tenant!.slug}`);
});

test('platform admin creates an organisation and the owner joins from the emailed invitation', async ({
	page,
	request
}) => {
	const secret = newTotpSecret();
	const f = await fixture(request, { users: [{ key: 'padmin', platformAdmin: true, totpSecret: secret }] });
	await signIn(page, f.users.padmin.email);
	await page.getByLabel('Code').fill(hotp(base32Decode(secret), timeStep(new Date())));
	await page.getByRole('button', { name: 'Verify' }).click();
	await page.goto('/platform');

	const slug = `org-${Date.now().toString(36)}`;
	const ownerEmail = `owner-${slug}@e2e.local`;
	await page.getByLabel('Name', { exact: true }).fill('Invited Org');
	await page.getByLabel('URL name').fill(slug);
	await page.getByLabel('Owner email').fill(ownerEmail);
	await page.getByRole('button', { name: 'Create and invite owner' }).click();
	await expect(page.getByRole('status')).toContainText(`Organisation ${slug} created`);

	const link = mailLink((await waitForMail(ownerEmail)).text);
	await page.context().clearCookies();
	await page.goto(new URL(link).pathname);
	await expect(page.getByRole('heading', { name: 'Join Invited Org' })).toBeVisible();
	await page.getByLabel('Your name').fill('Org Owner');
	await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
	await page.getByLabel('Repeat password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Create account and join' }).click();
	await expect(page).toHaveURL(`/t/${slug}`);

	const reuse = await page.goto(new URL(link).pathname);
	expect(reuse?.status()).toBe(410);
});

test('platform pages are hidden from members and admins must enrol two-factor first', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [{ key: 'member' }, { key: 'newadmin', platformAdmin: true, member: false }]
	});
	await signIn(page, f.users.member.email);
	expect((await page.goto('/platform'))?.status()).toBe(404);
	await page.context().clearCookies();
	await signIn(page, f.users.newadmin.email);
	await page.goto('/platform');
	await expect(page).toHaveURL(/\/account\/security\?required=1/);
});

test('forgotten password is reset through the emailed link', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'forgetful' }] });
	await page.goto('/forgot-password');
	await page.getByLabel('Email').fill(f.users.forgetful.email);
	await page.getByRole('button', { name: 'Send reset link' }).click();
	await expect(page.getByRole('status')).toContainText('If an account exists');
	const link = mailLink((await waitForMail(f.users.forgetful.email)).text);
	await page.goto(new URL(link).pathname);
	await page.getByLabel('New password', { exact: true }).fill('a fresh new passphrase');
	await page.getByLabel('Repeat new password').fill('a fresh new passphrase');
	await page.getByRole('button', { name: 'Set password' }).click();
	await expect(page).toHaveURL(/notice=reset/);
	await signIn(page, f.users.forgetful.email, 'a fresh new passphrase');
	await expect(page).toHaveURL(`/t/${f.tenant!.slug}`);
});
