import { expect, test } from '@playwright/test';
import { fixture, PASSWORD, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };

test('the owner confirms their password, makes a read-only API key, uses it and revokes it', async ({
	page,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'own', roles: ['owner'], employee: true },
			{ key: 'ana', roles: ['employee'], employee: true }
		]
	});
	await page.setViewportSize(PHONE);
	await signIn(page, f.users.own.email);
	await page.goto(`/t/${f.tenant!.slug}/settings`);
	await page.getByRole('link', { name: 'API keys' }).first().click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('API keys');

	const add = page.getByRole('region', { name: 'New API key' });
	await add.getByLabel('Your password').fill('not my password');
	await add.getByRole('button', { name: 'Confirm' }).click();
	await expect(page.getByRole('alert')).toHaveText('Password is incorrect.');
	await add.getByLabel('Your password').fill(PASSWORD);
	await add.getByRole('button', { name: 'Confirm' }).click();
	await expect(page.getByRole('status')).toHaveText(/^Confirmed\./);

	await add.getByLabel('Name').fill('Payroll sync');
	await add.getByLabel('Employees').selectOption({ label: 'everyone' });
	await add.getByRole('button', { name: 'Make key' }).click();
	const key = await page.getByRole('region', { name: 'New key' }).getByLabel('API key').inputValue();
	expect(key).toMatch(/^hrp_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
	await expect(page.getByRole('region', { name: 'Payroll sync' }).getByTestId('api-key-state')).toContainText(
		`hrp_${key.slice(4, 12)}_`
	);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

	const headers = { authorization: `Bearer ${key}` };
	const res = await request.get('/api/v1/employees', { headers });
	expect(res.status()).toBe(200);
	const body = (await res.json()) as { data: { fullName: string; nationalId?: string }[] };
	expect(body.data.map((e) => e.fullName.split(' ')[0]).sort()).toEqual(['ana', 'own']);
	expect((await request.get('/api/v1/leave-requests?from=2026-11-01&to=2026-11-30', { headers })).status()).toBe(403);
	expect((await request.get('/api/v1/openapi.json')).status()).toBe(200);

	await page.reload();
	await page.getByRole('button', { name: 'Revoke Payroll sync' }).click();
	await expect(page.getByRole('status')).toHaveText(/^Key revoked\./);
	await expect(page.getByRole('region', { name: 'Payroll sync' }).getByTestId('api-key-state')).toContainText(
		'Revoked'
	);
	expect((await request.get('/api/v1/employees', { headers })).status()).toBe(401);
});
