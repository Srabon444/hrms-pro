import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mailLink, waitForMail } from '../mailpit';
import { fixture, signIn } from './fixtures';

test('payroll computes a month and a festival bonus that finance approves and pays', async ({ page, request }) => {
	test.slow();
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'adm', roles: ['hr_admin'] },
			{ key: 'po', roles: ['payroll_officer'] },
			{ key: 'fin', roles: ['finance'] },
			{ key: 'ana', roles: ['employee'], employee: true }
		]
	});
	const t = `/t/${f.tenant!.slug}`;
	const as = async (key: string, path: string) => {
		await page.context().clearCookies();
		await signIn(page, f.users[key].email);
		await page.goto(`${t}/${path}`);
		await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	};
	const status = (p: Page | Locator) => p.getByRole('status');

	await as('adm', 'settings/tax');
	await page.getByRole('button', { name: 'Set up tax year' }).click();
	await expect(status(page)).toContainText('set up. Review and confirm it.');

	await as('po', 'payroll/salaries');
	const offer = page.getByRole('region', { name: 'New salary' });
	await offer.getByLabel('Employee').selectOption(f.users.ana.employeeId!);
	await offer.getByLabel('Starts on').fill('2026-01-05');
	await offer.getByLabel('Basic (৳)').fill('30000');
	await offer.getByLabel('Reason').fill('Offer letter');
	await offer.getByRole('button', { name: 'Send for approval' }).click();
	await expect(status(page)).toHaveText('Salary change sent for approval.');
	await as('fin', 'payroll/salaries');
	await page.getByRole('button', { name: /^Approve salary of ana/ }).click();
	await expect(status(page)).toHaveText('Salary change approved.');

	await as('po', '');
	await page.getByRole('link', { name: 'Payroll', exact: true }).click();
	await page.getByRole('button', { name: 'Run payroll' }).click();
	await expect(status(page)).toHaveText('Payroll computed. Review it and send it for approval.');
	const run = page.getByRole('region', { name: 'Payroll run' });
	await expect(run.getByRole('heading')).toContainText('Waiting for approval');
	await expect(run.getByRole('link', { name: 'Payroll register (CSV)' })).toBeVisible();
	await expect(run.getByRole('link', { name: 'Bank salary sheet (CSV)' })).toHaveCount(0);
	await expect(run.getByTestId('run-totals')).toContainText('1 payslip(s) · Gross ৳30000.00');
	await expect(run.getByTestId('payslip-row')).toContainText(/ana .* \(E2E-ANA\)/);
	await expect(run.getByRole('button', { name: 'Approve payroll' })).toHaveCount(0);

	await as('fin', 'approvals');
	await page.getByRole('link', { name: /^Payroll for \d{4}-\d{2}/ }).click();
	await page.getByRole('button', { name: 'Approve payroll' }).click();
	await expect(page.getByRole('alert')).toContainText('tax rules before approving payroll');

	await as('adm', 'settings/tax');
	await page.getByRole('button', { name: /^Confirm rules for / }).click();
	await expect(status(page)).toHaveText('Tax rules confirmed.');

	await as('fin', 'payroll');
	await page.getByRole('button', { name: 'Approve payroll' }).click();
	await expect(status(page)).toHaveText('Payroll approved.');
	await expect(run.getByRole('button', { name: 'Recompute' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Mark paid' }).click();
	await expect(status(page)).toHaveText('Payroll marked paid.');
	await expect(run.getByRole('heading')).toContainText('· Paid');
	await expect(run.getByRole('button')).toHaveCount(0);
	const sheet = page.waitForEvent('download');
	await run.getByRole('link', { name: 'Bank salary sheet (CSV)' }).click();
	const bankSheet = await sheet;
	expect(bankSheet.suggestedFilename()).toMatch(/^regular-\d{4}-\d{2}-bank\.csv$/);
	expect(readFileSync((await bankSheet.path())!, 'utf8')).toContain(
		'Code,Name,Bank,Account name,Account number,Amount'
	);

	await expect(page.getByRole('link', { name: 'My payslips' })).toHaveCount(0);

	const mail = await waitForMail(f.users.ana.email, 20_000, 'Your payslip for');
	expect(mail.text).not.toContain('৳');
	expect(mail.attachments).toEqual([]);
	await as('ana', 'payroll');
	await expect(page.getByText('You do not have permission to do that.')).toBeVisible();
	await page.goto(mailLink(mail.text));
	const slip = page.getByTestId('my-payslip');
	await expect(slip).toHaveCount(1);
	const period = mail.subject.slice(-7);
	await expect(slip).toContainText(`${period} · Net ৳`);
	const download = page.waitForEvent('download');
	await slip.getByRole('link', { name: `Download PDF of ${period}` }).click();
	expect((await download).suggestedFilename()).toBe(`payslip-${period}.pdf`);
	const pdfPanel = page.getByRole('region', { name: 'Payslip PDF password' });
	await pdfPanel.getByLabel('New payslip password').fill('river lantern 42 maple');
	await pdfPanel.getByLabel('Repeat it').fill('river lantern 42 maple');
	await pdfPanel.getByRole('button', { name: 'Set password' }).click();
	await expect(status(pdfPanel)).toHaveText('Payslip password saved.');
	await as('adm', 'settings/payroll');
	await page.getByLabel('Attach the payslip PDF to the payslip email').check();
	await page.getByRole('button', { name: 'Save payroll settings' }).click();
	await expect(status(page)).toHaveText('Payroll settings saved.');

	await as('po', 'payroll');
	await page.getByLabel('What to pay').selectOption('bonus');
	await page.getByLabel('Bonus name').fill('Eid-ul-Adha bonus');
	await page.getByRole('button', { name: 'Run payroll' }).click();
	await expect(status(page)).toHaveText('Payroll computed. Review it and send it for approval.');
	await expect(run.getByRole('heading')).toHaveText(`Eid-ul-Adha bonus for ${period} · Waiting for approval`);
	await expect(run.getByTestId('run-totals')).toContainText('1 payslip(s) · Gross ৳30000.00 · Deductions ৳0.00');
	await as('fin', 'approvals');
	await page.getByRole('link', { name: `Eid-ul-Adha bonus for ${period}` }).click();
	await page.getByRole('button', { name: 'Approve payroll' }).click();
	await expect(status(page)).toHaveText('Payroll approved.');
	await page.getByRole('button', { name: 'Mark paid' }).click();
	await expect(status(page)).toHaveText('Payroll marked paid.');

	const bonusMail = await waitForMail(f.users.ana.email, 20_000, `Your Eid-ul-Adha bonus payslip for ${period}`);
	expect(bonusMail.attachments).toEqual([`bonus-${period}.pdf`]);
	expect(bonusMail.text).toContain('The payslip PDF is attached.');
	await as('ana', 'payslips');
	await expect(slip).toHaveCount(2);
	const bonus = slip.filter({ hasText: 'Eid-ul-Adha bonus' });
	await expect(bonus).toContainText(`${period} · Eid-ul-Adha bonus · Net ৳30000.00`);
	const bonusPdf = page.waitForEvent('download');
	await bonus.getByRole('link', { name: `Download PDF of ${period} Eid-ul-Adha bonus` }).click();
	expect((await bonusPdf).suggestedFilename()).toBe(`bonus-${period}.pdf`);
});

test('payroll settles a leaver with notice pay that finance approves and pays', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'adm', roles: ['hr_admin'] },
			{ key: 'po', roles: ['payroll_officer'] },
			{ key: 'fin', roles: ['finance'] },
			{ key: 'bob', roles: ['employee'], employee: true }
		]
	});
	const t = `/t/${f.tenant!.slug}`;
	const as = async (key: string, path: string) => {
		await page.context().clearCookies();
		await signIn(page, f.users[key].email);
		await page.goto(`${t}/${path}`);
		await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	};
	const status = page.getByRole('status');
	const today = new Date().toISOString().slice(0, 10);

	await as('adm', 'settings/tax');
	await page.getByRole('button', { name: 'Set up tax year' }).click();
	await expect(status).toContainText('set up. Review and confirm it.');
	await page.getByRole('button', { name: /^Confirm rules for / }).click();
	await expect(status).toHaveText('Tax rules confirmed.');

	await as('po', 'payroll/salaries');
	const offer = page.getByRole('region', { name: 'New salary' });
	await offer.getByLabel('Employee').selectOption(f.users.bob.employeeId!);
	await offer.getByLabel('Starts on').fill('2026-01-05');
	await offer.getByLabel('Basic (৳)').fill('30000');
	await offer.getByLabel('Reason').fill('Offer letter');
	await offer.getByRole('button', { name: 'Send for approval' }).click();
	await expect(status).toHaveText('Salary change sent for approval.');
	await as('fin', 'payroll/salaries');
	await page.getByRole('button', { name: /^Approve salary of bob/ }).click();
	await expect(status).toHaveText('Salary change approved.');

	await as('adm', `employees/${f.users.bob.employeeId}`);
	const exit = page.getByRole('region', { name: 'Exit' });
	await exit.getByLabel('Last working day').fill(today);
	await exit.getByLabel('Exit type').selectOption('termination');
	await exit.getByRole('button', { name: 'Record exit' }).click();
	await expect(status).toHaveText('Exit recorded.');

	await as('po', 'payroll');
	await page.getByLabel('What to pay').selectOption('final');
	await expect(page.getByLabel('Month', { exact: true })).toHaveCount(0);
	await page.getByLabel('Who is leaving').selectOption(f.users.bob.employeeId!);
	await page.getByLabel('Notice paid in lieu (days)').fill('10');
	await page.getByRole('button', { name: 'Run payroll' }).click();
	await expect(status).toHaveText('Payroll computed. Review it and send it for approval.');
	const period = today.slice(0, 7);
	const run = page.getByRole('region', { name: 'Payroll run' });
	await expect(run.getByRole('heading')).toHaveText(
		new RegExp(`^Final settlement for ${period} · bob \\w+ · Waiting for approval$`)
	);
	await expect(run.getByTestId('payslip-row')).toContainText("Pay in lieu of 10 days' notice: ৳10000.00");
	await expect(page.getByRole('navigation', { name: 'Payroll runs' })).toContainText(/Final settlement · bob \w+/);

	await as('fin', 'approvals');
	await page.getByRole('link', { name: new RegExp(`^Final settlement for ${period} · bob`) }).click();
	await page.getByRole('button', { name: 'Approve payroll' }).click();
	await expect(status).toHaveText('Payroll approved.');
	await page.getByRole('button', { name: 'Mark paid' }).click();
	await expect(status).toHaveText('Payroll marked paid.');
	await expect(run.getByRole('heading')).toContainText('· Paid');

	await as('po', 'payroll');
	await page.getByLabel('What to pay').selectOption('final');
	await expect(page.getByLabel('Who is leaving').getByRole('option')).toHaveText(['Choose…']);
});
