import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an owner gets line errors for a bad opening balance file', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'own', roles: ['owner'], employee: true }] });
	await signIn(page, f.users.own.email);
	await page.goto(`/t/${f.tenant!.slug}/settings/leave-types`);
	const section = page.getByRole('region', { name: 'Opening balances' });
	await expect(section.getByRole('link', { name: 'Download template' })).toHaveAttribute(
		'download',
		'leave-balances.csv'
	);
	await section.getByLabel(/Balances file/).setInputFiles({
		name: 'b.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('employee_code,leave_type_code,balance,note\nNOPE-1,casual,5,Opening\n')
	});
	await section.getByRole('button', { name: 'Import balances' }).click();
	await expect(page.getByTestId('import-error')).toHaveText(['Line 2: No employee has this code.']);
});
