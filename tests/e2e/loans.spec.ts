import { expect, test } from '@playwright/test';
import { waitForMail } from '../mailpit';
import { fixture, signIn } from './fixtures';

test('an employee asks for a loan and finance approves the repayment plan', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'fin', roles: ['finance'] },
			{ key: 'ana', roles: ['employee'], employee: true }
		]
	});
	await signIn(page, f.users.ana.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Loans', exact: true }).click();
	const form = page.getByRole('region', { name: 'New request' });
	const start = await form.getByLabel('First repayment month').inputValue();
	await form.getByLabel('Amount (৳)').fill('10000.50');
	await form.getByLabel('Instalments').fill('3');
	await form.getByLabel('Reason').fill('Medical bills');
	await form.getByRole('button', { name: 'Send request' }).click();
	await expect(page.getByRole('status')).toHaveText('Request sent for approval.');
	await expect(page.getByTestId('my-loan')).toContainText('Loan ৳10000.50 · Waiting for approval');
	const dBox = page.getByTestId('my-loan').getByRole('group', { name: 'Documents' });
	await dBox.getByText('Documents (0)').click();
	await dBox
		.getByLabel('Files to attach')
		.setInputFiles({ name: 'bills.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 bills.pdf') });
	await dBox.getByRole('button', { name: 'Attach files' }).click();
	await expect(dBox.getByTestId('attachment')).toContainText('bills.pdf');

	await page.context().clearCookies();
	await signIn(page, f.users.fin.email);
	await page.goto(`/t/${f.tenant!.slug}/approvals`);
	await page.getByRole('link', { name: /৳10000\.50 over 3 month\(s\)/ }).click();
	await expect(page.getByTestId('loan-to-decide').getByTestId('attachment')).toContainText('bills.pdf');
	await page.getByRole('button', { name: /^Approve request of ana/ }).click();
	await expect(page.getByRole('status')).toHaveText('Request approved.');
	await expect(page.getByTestId('active-loan')).toContainText('৳10000.50৳0.00৳10000.50');

	const mail = await waitForMail(f.users.ana.email, 15_000, 'Loan approved');
	expect(mail.text).toContain(`starts with the ${start} salary`);
	await page.context().clearCookies();
	await signIn(page, f.users.ana.email);
	await page.goto(`/t/${f.tenant!.slug}/loans`);
	const mine = page.getByTestId('my-loan');
	await expect(mine).toContainText('Loan ৳10000.50 · Repaying · ৳10000.50 left');
	await expect(mine).toContainText(`${start} ৳3333.00`);
	await expect(mine).toContainText('৳3334.50');
});
