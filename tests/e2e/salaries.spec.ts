import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('a payroll officer proposes a salary and finance approves it', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'po', roles: ['payroll_officer'] },
			{ key: 'fin', roles: ['finance'] },
			{ key: 'ana', roles: ['employee'], employee: true }
		]
	});
	await signIn(page, f.users.po.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Salaries', exact: true }).click();
	const form = page.getByRole('region', { name: 'New salary' });
	await form.getByLabel('Employee').selectOption(f.users.ana.employeeId!);
	await form.getByLabel('Starts on').fill('2026-01-05');
	await form.getByLabel('Basic (৳)').fill('50000');
	await form.getByLabel('House rent (% of basic)').fill('50');
	await form.getByLabel('Medical allowance (৳)').fill('2000');
	await form.getByLabel('Reason').fill('Offer letter');
	await form.getByRole('button', { name: 'Send for approval' }).click();
	await expect(page.getByRole('status')).toHaveText('Salary change sent for approval.');
	const pending = page.getByTestId('salary-change');
	await expect(pending).toContainText('৳77000.00 gross from 2026-01-05');
	await expect(pending.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
	const docs = pending.getByRole('group', { name: 'Documents' });
	await docs.getByText('Documents (0)').click();
	await docs
		.getByLabel('Files to attach')
		.setInputFiles({ name: 'offer.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 offer') });
	await docs.getByRole('button', { name: 'Attach files' }).click();
	await expect(docs.getByTestId('attachment')).toContainText('offer.pdf');

	await page.context().clearCookies();
	await signIn(page, f.users.fin.email);
	await page.goto(`/t/${f.tenant!.slug}/approvals`);
	await page.getByRole('link', { name: /৳77000\.00 from 2026-01-05/ }).click();
	await expect(page.getByTestId('salary-change').getByTestId('attachment')).toContainText('offer.pdf');
	await expect(page.getByTestId('salary-change').getByRole('button', { name: 'Attach files' })).toHaveCount(0);
	await page.getByRole('button', { name: /^Approve salary of ana/ }).click();
	await expect(page.getByRole('status')).toHaveText('Salary change approved.');
	const row = page.getByTestId('salary-row').filter({ hasText: 'ana' });
	await expect(row).toContainText('৳77000.00');
	await expect(row).toContainText('Basic ৳50000.00, House rent ৳25000.00, Medical allowance ৳2000.00');
});
