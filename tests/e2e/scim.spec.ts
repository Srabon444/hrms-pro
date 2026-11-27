import { expect, test } from '@playwright/test';
import { fixture, PASSWORD, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };

test('the owner creates a provisioning token that adds people, then replaces and revokes it', async ({
	page,
	request
}) => {
	const f = await fixture(request, {
		tenant: { sso: {} },
		users: [{ key: 'own', roles: ['owner'], employee: true }]
	});
	await page.setViewportSize(PHONE);
	await signIn(page, f.users.own.email);
	await page.goto(`/t/${f.tenant!.slug}/settings/sso`);
	await page.locator('html[data-hydrated]').waitFor();
	const scim = page.getByRole('region', { name: 'Provisioning (SCIM)' });
	await expect(scim.getByTestId('scim-url')).toHaveText(/\/api\/scim\/v2$/);
	await expect(scim.getByTestId('scim-state')).toHaveText('No token yet.');
	await expect(scim.getByRole('button', { name: 'Create token' })).toBeDisabled();

	const confirm = page.getByRole('region', { name: 'Confirm it is you' });
	await confirm.getByLabel('Your password').fill(PASSWORD);
	await confirm.getByRole('button', { name: 'Confirm' }).click();
	await expect(page.getByRole('status')).toHaveText(/^Confirmed\./);

	await scim.getByRole('button', { name: 'Create token' }).click();
	await expect(page.getByRole('status')).toHaveText(/^Provisioning token created\./);
	const first = (await scim.getByTestId('scim-token').textContent())!.trim();
	expect(first).toMatch(/^hrs_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
	await expect(scim.getByTestId('scim-state')).toHaveText(`Token ${first.slice(0, 12)}_… is active.`);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

	const api = (token: string, method = 'GET', data?: unknown) =>
		request.fetch('/api/scim/v2/Users', {
			method,
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
			data
		});
	const made = await api(first, 'POST', { userName: `new-${Date.now()}@${f.ssoDomain}` });
	expect(made.status()).toBe(201);
	expect(made.headers()['content-type']).toContain('application/scim+json');
	expect((await (await api(first)).json()).totalResults).toBe(2);

	await page.reload();
	await expect(scim.getByTestId('scim-token')).toHaveCount(0);
	await scim.getByRole('button', { name: 'Replace token' }).click();
	await expect(page.getByRole('status')).toHaveText(/^Provisioning token created\./);
	const second = (await scim.getByTestId('scim-token').textContent())!.trim();
	expect(second).not.toBe(first);
	expect((await api(first)).status()).toBe(401);
	expect((await api(second)).status()).toBe(200);

	await scim.getByRole('button', { name: 'Revoke token' }).click();
	await expect(page.getByRole('status')).toHaveText('Provisioning token revoked.');
	await expect(scim.getByTestId('scim-state')).toHaveText('No token yet.');
	expect((await api(second)).status()).toBe(401);
});
