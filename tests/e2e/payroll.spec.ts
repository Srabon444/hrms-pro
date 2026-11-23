import { expect, test, type Page } from '@playwright/test';
import { mailLink, waitForMail } from '../mailpit';
import { fixture, signIn } from './fixtures';

test('payroll computes a month, waits for confirmed tax rules, and finance approves and pays it', async ({
	page,
	request
}) => {
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
	};
	const status = (p: Page) => p.getByRole('status');

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
});
