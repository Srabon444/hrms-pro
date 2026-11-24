import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an owner imports holidays from a CSV and sees line errors for a bad file', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'own', roles: ['owner'], employee: true }] });
	await signIn(page, f.users.own.email);
	await page.goto(`/t/${f.tenant!.slug}/org?year=2030`);
	const holidays = page.getByRole('region', { name: 'Holidays' });
	const upload = (body: string) =>
		holidays
			.getByLabel(/Holidays file/)
			.setInputFiles({ name: 'h.csv', mimeType: 'text/csv', buffer: Buffer.from(body) });
	await expect(holidays.getByRole('link', { name: 'Download template' })).toHaveAttribute('download', 'holidays.csv');
	await upload('date,name\n2030-12-16,Victory Day\n2030-12-16,Again\n');
	await holidays.getByRole('button', { name: 'Import holidays' }).click();
	await expect(page.getByTestId('import-error')).toHaveText(['Line 3: This date appears twice in the file.']);
	await upload('date,name\n2030-12-16,Victory Day\n2030-12-25,Christmas\n');
	await holidays.getByRole('button', { name: 'Import holidays' }).click();
	await expect(page.getByRole('status')).toHaveText('2 holidays imported.');
	await page.goto(`/t/${f.tenant!.slug}/org?year=2030`);
	await expect(holidays.getByRole('listitem')).toHaveText([/2030-12-16\s*Victory Day/, /2030-12-25\s*Christmas/]);
});
