import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an owner downloads employees and a dated leave ledger as CSV from settings', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'own', roles: ['owner'], employee: true }] });
	await signIn(page, f.users.own.email);
	await page.goto(`/t/${f.tenant!.slug}/settings`);
	await page.getByRole('link', { name: 'Data export' }).click();
	const people = page.getByRole('region', { name: 'Employees' });
	const pending = page.waitForEvent('download');
	await people.getByRole('button', { name: 'Download employees' }).click();
	const file = await pending;
	expect(file.suggestedFilename()).toMatch(/^employees-\d{4}-\d{2}-\d{2}\.csv$/);
	expect((await readFile((await file.path())!, 'utf8')).split('\r\n')[0]).toContain('code,full_name');
	const leave = page.getByRole('region', { name: 'Leave ledger' });
	await leave.getByLabel('From').fill('2026-01-01');
	await leave.getByLabel('To').fill('2026-12-31');
	const ledger = page.waitForEvent('download');
	await leave.getByRole('button', { name: 'Download leave ledger' }).click();
	expect((await ledger).suggestedFilename()).toBe('leave-2026-01-01-to-2026-12-31.csv');
});
