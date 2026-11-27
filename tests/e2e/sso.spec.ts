import { expect, test } from '@playwright/test';
import { base32Decode, hotp, newTotpSecret, timeStep } from '../../src/lib/server/auth/totp';
import { fixture, PASSWORD, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };

test('the owner confirms their password, saves a Google connection and adds a domain to verify', async ({
	page,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'staff', employee: true }
		]
	});
	await page.setViewportSize(PHONE);
	await signIn(page, f.users.own.email);
	await page.goto(`/t/${f.tenant!.slug}/settings`);
	await page.getByRole('link', { name: 'Company sign-in' }).first().click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Company sign-in');
	await expect(page.getByTestId('redirect-uri')).toHaveText(/\/sso\/callback$/);
	await expect(page.getByRole('button', { name: 'Save connection' })).toBeDisabled();

	const confirm = page.getByRole('region', { name: 'Confirm it is you' });
	await confirm.getByLabel('Your password').fill(PASSWORD);
	await confirm.getByRole('button', { name: 'Confirm' }).click();
	await expect(page.getByRole('status')).toHaveText(/^Confirmed\./);

	const conn = page.getByRole('region', { name: 'Connection' });
	await conn.getByLabel('Client ID').fill('e2e-ui.apps.googleusercontent.com');
	await expect(conn.getByLabel('Client secret')).toHaveAttribute('required', '');
	await conn.getByLabel('Client secret').fill('ui-secret');
	await conn.getByRole('button', { name: 'Save connection' }).click();
	await expect(page.getByRole('status')).toHaveText('Connection saved.');
	await expect(conn.getByTestId('sso-state')).toHaveText(/^On · Optional · 0 people linked$/);
	await expect(conn.getByLabel('Client secret')).toHaveValue('');

	await conn.getByLabel('Provider').selectOption('entra');
	await expect(conn.getByLabel('Directory (tenant) ID')).toBeVisible();
	await conn.getByLabel('Provider').selectOption('google');

	const domains = page.getByRole('region', { name: 'Email domains' });
	await expect(domains.getByTestId('txt-value')).toHaveText(/^hrms-sso-verify=[A-Za-z0-9_-]{20,}$/);
	await domains.getByLabel('Domain').fill('not a domain');
	await domains.getByRole('button', { name: 'Add domain' }).click();
	await expect(page.getByRole('alert')).toHaveText('Enter a domain like example.com.');
	const domain = `ui-${Date.now()}.example`;
	await domains.getByLabel('Domain').fill(domain);
	await domains.getByRole('button', { name: 'Add domain' }).click();
	await expect(page.getByRole('status')).toHaveText(/^Domain added\./);
	await expect(domains.getByTestId('sso-domain')).toHaveText(new RegExp(`${domain}\\s*Not verified`));
	await domains.getByRole('button', { name: `Check ${domain}` }).click();
	await expect(page.getByRole('alert')).toHaveText(new RegExp(`could not find the TXT record on ${domain}`));
	await conn.getByRole('button', { name: 'Require it for everyone but the owner' }).click();
	await expect(page.getByRole('alert')).toHaveText('Turn company sign-in on and verify a domain before requiring it.');
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

	await domains.getByRole('button', { name: `Remove ${domain}` }).click();
	await expect(page.getByRole('status')).toHaveText('Domain removed.');
	await conn.getByRole('button', { name: 'Turn off company sign-in' }).click();
	await expect(conn.getByTestId('sso-state')).toHaveText(/^Off · Optional/);

	await page.context().clearCookies();
	await signIn(page, f.users.staff.email);
	await page.waitForURL(/\/t\//);
	const res = await page.goto(`/t/${f.tenant!.slug}/settings/sso`);
	expect(res?.status()).toBe(403);
});

test('company sign-in is found from the work email and required for everyone but the owner', async ({
	page,
	request
}) => {
	const secret = newTotpSecret();
	const f = await fixture(request, {
		tenant: { sso: { enforce: true } },
		users: [
			{ key: 'own', roles: ['owner'], employee: true, totpSecret: secret },
			{ key: 'own2', roles: ['owner'] },
			{ key: 'staff', employee: true },
			{ key: 'gone', employee: true, exEmployee: true }
		]
	});
	await page.setViewportSize(PHONE);

	await page.goto('/login');
	await page.getByRole('link', { name: 'Use company sign-in' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Company sign-in');
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await page.getByLabel('Work email').fill('someone@nowhere-sso.example');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toHaveText(
		'Company sign-in is not set up for that email. Sign in with your password.'
	);
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await page.getByLabel('Work email').fill(`someone@${f.ssoDomain}`);
	await page.getByRole('button', { name: 'Continue' }).click();
	const href = await page.getByRole('link', { name: 'Continue to company sign-in' }).getAttribute('href');
	const toIdp = await page.request.get(href!, { maxRedirects: 0 });
	expect(toIdp.status()).toBe(303);
	const idp = new URL(toIdp.headers().location);
	expect(idp.origin).toBe('https://accounts.google.com');
	expect(idp.searchParams.get('client_id')).toMatch(/^e2e-.*\.apps\.googleusercontent\.com$/);
	expect(idp.searchParams.get('redirect_uri')).toMatch(/\/sso\/callback$/);
	expect((await page.context().cookies()).find((c) => c.name === 'hrms_sso')).toMatchObject({
		httpOnly: true,
		path: '/sso'
	});

	await page.goto('/sso/callback?state=forged&code=x');
	await expect(page).toHaveURL(/\/login\?sso=sso_expired$/);
	await expect(page.getByRole('alert')).toHaveText('That sign-in took too long. Start again.');

	const origin = new URL(page.url()).origin;
	const signedIn = await page.request.post('/login', {
		form: { email: f.users.staff.email, password: PASSWORD, next: '/' },
		headers: { origin },
		maxRedirects: 0
	});
	expect(await signedIn.json()).toMatchObject({ type: 'redirect', location: '/' });
	const home = await page.request.get(`/t/${f.tenant!.slug}/leave`, { maxRedirects: 0 });
	expect(home.status()).toBe(303);
	const start = new URL(home.headers().location, origin);
	expect(start.pathname).toBe('/sso/start');
	expect(start.searchParams.get('t')).toBe(f.tenant!.id);
	expect(start.searchParams.get('next')).toBe(`/t/${f.tenant!.slug}/leave`);
	const encoded = await page.request.get(`/%74/${f.tenant!.slug}/leave`, { maxRedirects: 0 });
	expect(new URL(encoded.headers().location, origin).pathname).toBe('/sso/start');

	const passwordIn = async (email: string) => {
		await page.context().clearCookies();
		const r = await page.request.post('/login', {
			form: { email, password: PASSWORD, next: '/' },
			headers: { origin },
			maxRedirects: 0
		});
		expect(await r.json()).toMatchObject({ type: 'redirect', location: '/' });
		return page.request.get(`/t/${f.tenant!.slug}/leave`, { maxRedirects: 0 });
	};
	const noTotpOwner = await passwordIn(f.users.own2.email);
	expect(new URL(noTotpOwner.headers().location, origin).pathname).toBe('/sso/start');
	const exEmployee = await passwordIn(f.users.gone.email);
	expect(exEmployee.headers().location ?? '').not.toContain('/sso/start');

	await page.context().clearCookies();
	await signIn(page, f.users.own.email);
	await page.getByLabel('Code').fill(hotp(base32Decode(secret), timeStep(new Date())));
	await page.getByRole('button', { name: 'Verify' }).click();
	await page.waitForURL(new RegExp(`/t/${f.tenant!.slug}`));
	await page.goto(`/t/${f.tenant!.slug}/settings/sso`);
	await expect(page.getByTestId('sso-state')).toHaveText(
		/^On · Required for everyone but the owner · 0 people linked$/
	);
	await expect(page.getByRole('region', { name: 'Email domains' }).getByTestId('sso-domain')).toHaveText(
		new RegExp(`${f.ssoDomain}\\s*Verified`)
	);

	await page.goto('/account/security');
	const links = page.getByRole('region', { name: 'Company sign-in' });
	await expect(links.getByTestId('sso-link')).toContainText('Not linked');
});

test('a company sign-in session opens only its own organisation and cannot change account security', async ({
	page,
	request
}) => {
	const f = await fixture(request, {
		tenant: { sso: {} },
		users: [{ key: 'lock', roles: ['owner'], employee: true, platformAdmin: true, ssoSession: true }]
	});
	await page.setViewportSize(PHONE);
	await page.goto('/login');
	const origin = new URL(page.url()).origin;
	await page.context().addCookies([{ name: 'hrms_session', value: f.users.lock.ssoToken!, url: origin }]);
	await page.goto('/');
	await expect(page).toHaveURL(new RegExp(`/t/${f.tenant!.slug}`));
	for (const path of ['/platform', '/%70latform', '/platform/__data.json', '/%70latform/__data.json'])
		expect((await page.request.get(path, { maxRedirects: 0 })).status(), path).toBeGreaterThanOrEqual(403);
	const suspend = await page.request.post('/%70latform?/status', {
		form: { tenantId: f.tenant!.id, status: 'suspended' },
		headers: { origin },
		maxRedirects: 0
	});
	expect(suspend.status()).toBeGreaterThanOrEqual(403);

	await page.goto('/account/security');
	await expect(page.getByRole('status').first()).toHaveText(
		'You signed in with a company account. Sign in with your password to change these settings.'
	);
	await expect(page.getByTestId('sso-link')).toContainText('Not linked');
	await expect(page.getByRole('button', { name: /^Link / })).toHaveCount(0);
	const change = await page.request.post('/account/security?/reauth', {
		form: { password: PASSWORD },
		headers: { origin },
		maxRedirects: 0
	});
	expect(change.status()).toBe(403);
	const link = await page.request.get(`/sso/start?t=${f.tenant!.id}&link=1`, { maxRedirects: 0 });
	expect(new URL(link.headers().location, origin).pathname).toBe('/login');
});
