import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an owner imports assets from a CSV and sees line errors for a bad file', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'own', roles: ['owner'], employee: true }] });
	await signIn(page, f.users.own.email);
	await page.goto(`/t/${f.tenant!.slug}/assets`);
	const section = page.getByRole('region', { name: 'Import assets' });
	const upload = (body: string) =>
		section.getByLabel(/Assets file/).setInputFiles({ name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from(body) });
	const header = 'tag,name,category,serial,purchase_date,purchase_cost\n';
	await upload(`${header}LAP-1,Laptop,Laptop,,,\nlap-1,Laptop,Laptop,,,\n`);
	await section.getByRole('button', { name: 'Import assets' }).click();
	await expect(page.getByTestId('import-error')).toHaveText(['Line 3: This tag appears twice in the file.']);
	await upload(`${header}LAP-1,Laptop,Laptop,SN1,2026-01-15,120000\nDSK-1,Desk,Furniture,,,\n`);
	await section.getByRole('button', { name: 'Import assets' }).click();
	await expect(page.getByRole('status')).toHaveText('2 assets imported.');
	await expect(page.getByRole('region', { name: 'Asset list' })).toContainText('LAP-1');
	await expect(page.getByRole('region', { name: 'Asset list' })).toContainText('DSK-1');
});
