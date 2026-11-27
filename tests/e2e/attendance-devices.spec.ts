import { expect, test } from '@playwright/test';
import { fixture, PASSWORD, signIn } from './fixtures';

const PHONE = { width: 390, height: 844 };

test('the owner adds a fingerprint reader, maps a device user ID, the reader posts punches and is switched off', async ({
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
	await page.getByRole('link', { name: 'Attendance devices' }).first().click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Attendance devices');
	await expect(page.getByRole('region', { name: 'Punches to check' })).toContainText('Nothing to check.');

	const add = page.getByRole('region', { name: 'New device' });
	await add.getByLabel('Your password').fill(PASSWORD);
	await add.getByRole('button', { name: 'Confirm' }).click();
	await expect(page.getByRole('status')).toHaveText(/^Confirmed\./);
	await add.getByLabel('Name').fill('Front gate');
	await add.getByLabel('Serial number').fill('ZK-4500');
	await add.getByRole('button', { name: 'Add device' }).click();
	const key = await page.getByRole('region', { name: 'Device key' }).getByLabel('Device key').inputValue();
	expect(key).toMatch(/^hrd_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
	const card = page.getByRole('region', { name: 'Front gate' });
	await expect(card.getByTestId('device-state')).toContainText(
		`hrd_${key.slice(4, 12)}_… · On · ZK-4500 · last seen never`
	);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

	const users = page.getByRole('region', { name: 'Device user IDs' });
	await users.getByLabel('Employee code').fill('E2E-ANA');
	await users.getByLabel('Device user ID').fill('42');
	await users.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('status')).toHaveText(/^Saved the device user ID for ana /);
	await expect(page.getByTestId('device-users')).toContainText('E2E-ANA');

	const at = new Date(Date.now() - 3_600_000).toISOString();
	const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
	const res = await request.post('/api/v1/punches', {
		headers,
		data: {
			punches: [
				{ deviceUserId: '42', at, direction: 'in' },
				{ deviceUserId: '77', at }
			]
		}
	});
	expect(res.status()).toBe(200);
	const body = (await res.json()) as {
		accepted: number;
		results: { index: number; status: string; reason?: string }[];
	};
	expect(body.accepted).toBe(1);
	expect(body.results.map((r) => [r.index, r.reason ?? r.status])).toEqual([
		[0, 'accepted'],
		[1, 'unknown_user']
	]);

	await page.reload();
	await expect(card.getByTestId('device-state')).not.toContainText('last seen never');
	await card.getByRole('button', { name: 'Switch off Front gate' }).click();
	await expect(page.getByRole('status')).toHaveText('Device switched off. Its key stops working now.');
	await expect(card.getByTestId('device-state')).toContainText('Switched off');
	const after = await request.post('/api/v1/punches', { headers, data: { punches: [{ deviceUserId: '42', at }] } });
	expect(after.status()).toBe(401);
});
