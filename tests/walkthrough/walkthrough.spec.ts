import { expect, test, type Locator, type Page } from '@playwright/test';
import { caption, chapter, pause, scrollThrough, signIn, signOut } from './helpers';

const LEAVE_DAY = process.env.WALK_LEAVE_DAY ?? '2026-12-14';
const MISSED_PUNCH = process.env.WALK_MISSED_PUNCH ?? '2026-11-23T08:50';
const CLAIM_DAY = process.env.WALK_CLAIM_DAY ?? '2026-11-23';
const IMRAN = '/t/demo/employees/818f4bbe-ae47-495b-b32e-6e9d45264378';
const LAMIA = '/t/demo/employees/320b3a44-92f7-4784-a52b-65133f85658f';
const ARIF_REVIEW = '/t/demo/performance/reviews/55ef22f8-9cb3-4cc0-bc32-c64b6de7b2f8';
const VPN_TICKET = '/t/demo/helpdesk/543c4833-e99f-4dc6-ac73-43e2a9acf294';
const MAHMUDUL = '/t/demo/recruitment/candidates/7330554d-3811-4478-a4d1-c89ced1960ba';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function file(name: string) {
	return name.endsWith('.png')
		? { name, mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') }
		: { name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.7\n% ${name}\n`) };
}

async function go(page: Page, label: string) {
	await page.locator('#main-nav').getByRole('link', { name: label, exact: true }).click();
	await page.waitForLoadState('load');
}

async function visit(page: Page, label: string, title: string, detail: string, steps = 2) {
	await go(page, label);
	await caption(page, title, detail);
	await scrollThrough(page, steps);
}

async function open(page: Page, path: string) {
	await page.goto(path);
	await page.waitForLoadState('load');
}

async function type(field: Locator, text: string) {
	await field.pressSequentially(text, { delay: 35 });
}

async function attach(page: Page, scope: Locator, names: string[], compact = false, say?: [string, string]) {
	await scope.scrollIntoViewIfNeeded();
	if (say) await caption(page, ...say);
	if (compact) {
		await scope.locator('summary').click();
		await pause(page, 600);
	}
	await scope.getByLabel('Files to attach').setInputFiles(names.map(file));
	await pause(page, 800);
	await scope.getByRole('button', { name: 'Attach files' }).click();
	for (const name of names) await expect(scope.getByTestId('attachment').filter({ hasText: name })).toBeVisible();
	await pause(page, 1500);
}

async function inbox(page: Page, kind: string, who: string) {
	await go(page, 'Approvals');
	await page.locator(`a[href*="/approvals/${kind}/"]`, { hasText: who }).first().click();
	await page.waitForLoadState('load');
}

test('product walkthrough', async ({ page }) => {
	await page.goto('/login');
	await chapter(
		page,
		'HRMS Pro',
		'A multi-tenant HR system for a software company. Demo tenant: Nimbus Labs Ltd, 30 employees.'
	);
	await caption(
		page,
		'One login, many roles',
		'We will sign in as the owner, an engineer, a manager, HR, payroll and finance.'
	);

	await chapter(page, '1. The owner’s view', 'Company-wide dashboards, people, structure and access control.');
	await signIn(page, 'owner@demo.local');
	await caption(page, 'Owner home', 'Headcount, pending approvals, payroll and who is out today, all scoped by role.');
	await scrollThrough(page);
	await visit(
		page,
		'Employees',
		'Employee directory',
		'Search, filter, CSV import and export. Every row is tenant-isolated by Postgres RLS.',
		1
	);
	await page.locator('table a').first().click();
	await page.waitForLoadState('load');
	await caption(
		page,
		'Employee profile',
		'Job, pay, education, documents, history and an audit trail of every change.'
	);
	await scrollThrough(page, 4);
	await visit(page, 'Organisation', 'Organisation', 'Departments, designations, grades and branches.');
	await go(page, 'Settings');
	await caption(page, 'Settings hub', 'Every rule the company runs on, grouped and permission-gated.');
	await page.getByRole('link', { name: 'Roles' }).first().click();
	await page.waitForLoadState('load');
	await caption(
		page,
		'Role-based access',
		'Each permission is granted at own, team, department or whole-company scope.'
	);
	await scrollThrough(page, 3);
	await signOut(page);

	await chapter(
		page,
		'2. Employee self-service',
		'Imran, a software engineer, keeps his profile up to date and sends requests with supporting files.'
	);
	await signIn(page, 'staff@demo.local');
	await caption(page, 'Staff home', 'Imran sees only his own data: today’s shift, leave balance, meals and news.');

	await open(page, IMRAN);
	await caption(page, 'My profile', 'Employees keep their own education and experience up to date.');
	const education = page.getByRole('region', { name: 'Education' });
	await education.scrollIntoViewIfNeeded();
	await type(education.getByLabel('Degree'), 'BSc CSE');
	await type(education.getByLabel('Institution'), 'BUET');
	await type(education.getByLabel('Passing year'), '2019');
	await education.getByRole('button', { name: 'Add to education' }).click();
	await expect(education.getByText('BSc CSE, BUET (2019)', { exact: true })).toBeVisible();
	await attach(
		page,
		education.getByRole('group', { name: 'Certificates for BSc CSE, BUET (2019)' }),
		['bsc-certificate.pdf'],
		true,
		['Attach the certificate', 'Every education and experience entry can carry its certificate.']
	);

	await go(page, 'Leave');
	await caption(page, 'Request sick leave', 'Balances come from accrual rules. Weekends and holidays are skipped.');
	await page.getByRole('combobox', { name: 'Leave type' }).selectOption({ label: 'Sick leave' });
	await page.getByRole('textbox', { name: 'From', exact: true }).fill(LEAVE_DAY);
	await page.getByRole('textbox', { name: 'To', exact: true }).fill(LEAVE_DAY);
	await type(page.getByRole('textbox', { name: 'Reason', exact: true }), 'Fever, the doctor advised two days of rest');
	await page.getByLabel(/^Attachments/).setInputFiles([file('prescription.pdf')]);
	await caption(
		page,
		'Prescription attached',
		'Files go to MinIO object storage; only people allowed to see the request can open them.'
	);
	await page.getByRole('button', { name: 'Request leave' }).click();
	await expect(page.getByText('Leave requested.')).toBeVisible();
	await caption(page, 'Request sent', 'The approver gets an in-app notification and an email.');

	await go(page, 'Attendance');
	await caption(page, 'Attendance', 'Punch in and out, a monthly summary and correction requests.');
	const change = page.getByRole('region', { name: 'Ask for a change' });
	await change.getByLabel('Request').selectOption({ label: 'Missed punch' });
	await change.getByLabel('When you were in or out').fill(MISSED_PUNCH);
	await type(change.getByLabel('Reason'), 'The card reader at the gate was down');
	await change.getByRole('button', { name: 'Send request' }).click();
	await attach(page, change.getByRole('group', { name: 'Proof' }).first(), ['security-desk-log.pdf'], true, [
		'Proof for the correction',
		'A pending request takes proof, such as the security desk log.'
	]);

	await go(page, 'Loans');
	await caption(page, 'Loans and advances', 'Repayments are deducted from future payslips automatically.');
	const loan = page.getByRole('region', { name: 'New request' });
	await type(loan.getByLabel(/^Amount/), '60000');
	await loan.getByLabel('Instalments').fill('6');
	await type(loan.getByLabel('Reason'), 'Hospital bill for my father');
	await loan.getByRole('button', { name: 'Send request' }).click();
	await expect(page.getByText('Request sent for approval.')).toBeVisible();
	await attach(
		page,
		page.getByTestId('my-loan').first().getByRole('group', { name: 'Documents' }),
		['hospital-estimate.pdf'],
		true,
		['Supporting documents', 'The approver sees the hospital estimate next to the request.']
	);

	await open(page, VPN_TICKET);
	await caption(page, 'Helpdesk', 'Tickets to HR, IT or admin. Replies can carry screenshots.');
	const talk = page.getByRole('region', { name: 'Conversation' });
	await talk.scrollIntoViewIfNeeded();
	await type(talk.getByLabel('Comment'), 'Still dropping after the router reset. Screenshot attached.');
	await talk.getByLabel(/^Attach files/).setInputFiles([file('vpn-error.png')]);
	await pause(page, 800);
	await talk.getByRole('button', { name: 'Add comment' }).click();
	await expect(talk.getByText('vpn-error.png')).toBeVisible();
	await pause(page, 1500);

	await go(page, 'Expenses');
	await caption(page, 'Expense claims', 'Each line item carries its own receipt.');
	const claim = page.getByRole('region', { name: 'New claim' });
	await type(claim.getByLabel('Title'), 'Client visit to Gulshan');
	const item = claim.getByRole('group', { name: 'Item 1' });
	await item.getByLabel('Category').selectOption({ index: 1 });
	await item.getByLabel('Date').fill(CLAIM_DAY);
	await type(item.getByLabel('Description'), 'CNG fare, both ways');
	await type(item.getByLabel(/^Amount/), '650');
	await item.getByLabel('Receipt').setInputFiles(file('cng-receipt.pdf'));
	await pause(page, 800);
	await claim.getByRole('button', { name: 'Send claim' }).click();
	await page.waitForLoadState('load');
	await caption(page, 'Claim sent', 'It goes to the manager, then finance pays it with the next salary.');
	await visit(page, 'Meals', 'Meals', 'Order lunch by cut-off. The month-end bill is emailed to each employee.');
	await visit(page, 'My payslips', 'My payslips', 'Approved payslips with a downloadable PDF.', 1);
	await signOut(page);

	await chapter(page, '3. Performance reviews', 'Arif, a team lead, sets his goals and backs them with evidence.');
	await signIn(page, 'manager@demo.local');
	await open(page, ARIF_REVIEW);
	await caption(page, 'Half-year review', 'Goals are weighted. The weights must add up to 100 before the self review.');
	const goal = page.getByRole('region', { name: 'Add goal' });
	await type(goal.getByLabel('Goal'), 'Ship the Atlas beta');
	await type(goal.getByLabel('Target'), 'Released to pilot users by 15 December');
	await goal.getByLabel('Weight').fill('100');
	await goal.getByRole('button', { name: 'Add goal' }).click();
	await attach(
		page,
		page.getByRole('group', { name: 'Evidence for Ship the Atlas beta' }),
		['atlas-beta-release-notes.pdf'],
		true,
		['Evidence per goal', 'Release notes, dashboards or client mail, attached to the goal they prove.']
	);
	await attach(page, page.getByRole('region', { name: 'Review evidence' }), ['client-feedback.pdf'], false, [
		'Evidence for the whole review',
		'The manager sees the same files when rating.'
	]);
	await signOut(page);

	await chapter(page, '4. HR at work', 'Nusrat, Head of People, approves requests, hires and keeps everyone informed.');
	await signIn(page, 'hr@demo.local');
	await inbox(page, 'leave', 'Imran Hossain');
	await caption(
		page,
		'Leave with its prescription',
		'Days counted, the remaining balance, and the file Imran attached.'
	);
	await page.getByRole('region', { name: 'Attachments' }).scrollIntoViewIfNeeded();
	await pause(page, 1500);
	await page.getByRole('button', { name: 'Approve' }).click();
	await page.waitForLoadState('load');
	await caption(page, 'Approved', 'The balance is deducted and Imran is notified.');
	await inbox(page, 'attendance', 'Imran Hossain');
	await caption(page, 'Attendance correction', 'The security desk log sits next to the request.');
	await page.getByRole('region', { name: 'Attachments' }).scrollIntoViewIfNeeded();
	await pause(page, 1200);
	await page.getByRole('button', { name: 'Approve' }).click();
	await page.waitForLoadState('load');
	await pause(page, 1200);

	await go(page, 'Recruitment');
	await caption(page, 'Recruitment', 'Openings with a pipeline board from applied to hired.');
	await page.getByRole('link', { name: 'Senior Backend Engineer' }).click();
	await page.waitForLoadState('load');
	await caption(page, 'A new interviewee', 'Add the candidate with the CV they sent.');
	const add = page.getByRole('region', { name: 'Add candidate' });
	await add.scrollIntoViewIfNeeded();
	await type(add.getByLabel('Full name'), 'Nabila Rahman');
	await type(add.getByLabel('Email'), 'nabila.rahman@example.com');
	await type(add.getByLabel('Phone'), '+8801711000000');
	await add.getByLabel('Source').selectOption({ index: 1 });
	await type(add.getByLabel(/^Tags/), 'go, kubernetes');
	await add.getByLabel(/^Resume/).setInputFiles(file('nabila-rahman-cv.pdf'));
	await add.getByRole('button', { name: 'Add candidate' }).click();
	await expect(page.getByText('Candidate added.')).toBeVisible();
	await page.getByRole('region', { name: 'Pipeline' }).getByRole('link', { name: 'Nabila Rahman' }).click();
	await page.waitForLoadState('load');
	await attach(
		page,
		page.getByRole('region', { name: 'Candidate files' }),
		['portfolio.pdf', 'aws-certificate.pdf'],
		false,
		['Candidate files', 'Portfolio, certificates and ID copies stay with the candidate.']
	);
	await open(page, MAHMUDUL);
	await caption(page, 'Offer stage', 'Interview feedback from every panel member, then the offer.');
	await scrollThrough(page, 2);
	await attach(
		page,
		page.getByRole('region', { name: 'Offers' }).getByRole('group', { name: 'Offer letter' }),
		['offer-letter-mahmudul.pdf'],
		true,
		['Offer letter', 'The signed offer letter is attached to the offer itself.']
	);

	await go(page, 'Announcements');
	await caption(page, 'Announcements', 'Company news by audience, pinned and scheduled.');
	await page.getByRole('link', { name: 'Code freeze ahead of the Atlas release' }).first().click();
	await page.waitForLoadState('load');
	await attach(page, page.getByRole('region', { name: 'Attachments' }), ['atlas-release-calendar.pdf'], false, [
		'Files on announcements',
		'Readers get the release calendar with the news.'
	]);
	await signOut(page);

	await chapter(
		page,
		'5. Payroll and leaving',
		'Lamia runs salaries. Then she resigns, and we follow the exit end to end.'
	);
	await signIn(page, 'payroll@demo.local');
	await go(page, 'Salaries');
	await caption(page, 'Salary change', 'A new salary needs approval before payroll uses it.');
	const salary = page.getByRole('region', { name: 'New salary' });
	await salary.getByLabel('Employee').selectOption({ label: 'Imran Hossain (NL-0014)' });
	await type(salary.getByLabel(/^Basic/), '90000');
	await type(salary.getByLabel(/^Conveyance/), '5000');
	await type(salary.getByLabel(/^House rent/), '50');
	await type(salary.getByLabel(/^Medical/), '6000');
	await type(salary.getByLabel('Reason'), 'Annual increment 2026');
	await salary.getByRole('button', { name: 'Send for approval' }).click();
	await attach(
		page,
		page.getByTestId('salary-change').filter({ hasText: 'Imran Hossain' }).getByRole('group', { name: 'Documents' }),
		['increment-memo.pdf'],
		true,
		['The approval memo', 'Attached to the proposal so the approver sees why.']
	);

	await open(page, LAMIA);
	await caption(page, 'Resigning', 'The notice period comes from the settings, so the last day is suggested.');
	const resign = page.getByRole('region', { name: 'Resign' });
	await resign.scrollIntoViewIfNeeded();
	await type(resign.getByLabel('Why are you leaving?'), 'Moving to Chattogram to be near my family');
	await resign.getByRole('button', { name: 'Submit resignation' }).click();
	await expect(resign.getByRole('status')).toHaveText('Your resignation was sent.');
	await attach(page, resign.getByRole('region', { name: 'Attachments' }), ['resignation-letter.pdf'], false, [
		'The resignation letter',
		'The signed letter goes with the resignation to the manager and HR.'
	]);
	await signOut(page);

	await signIn(page, 'finance@demo.local');
	await inbox(page, 'resignations', 'Lamia Parvin');
	await caption(page, 'The manager decides first', 'Kamrul reads the letter, then agrees and sends it to HR.');
	await page.getByRole('region', { name: 'Attachments' }).scrollIntoViewIfNeeded();
	await pause(page, 1500);
	await page.getByRole('button', { name: 'Agree and send to HR' }).click();
	await expect(page.getByRole('status')).toHaveText('Decision saved.');
	await pause(page, 1200);
	await signOut(page);

	await signIn(page, 'hr@demo.local');
	await inbox(page, 'resignations', 'Lamia Parvin');
	await caption(page, 'HR accepts', 'HR agrees the last working day; access ends automatically after it.');
	await page.getByRole('button', { name: 'Accept' }).click();
	await expect(page.getByRole('status')).toHaveText('Decision saved.');
	await open(page, LAMIA);
	const exit = page.getByRole('region', { name: 'Exit', exact: true });
	await exit.scrollIntoViewIfNeeded();
	await caption(page, 'On notice', 'Exit letters such as the experience certificate are kept with her documents.');
	const letter = exit.getByRole('form', { name: 'Upload exit letter' });
	await type(letter.getByLabel('Letter title'), 'Experience certificate');
	await letter.getByLabel('Letter file').setInputFiles(file('experience-certificate.pdf'));
	await pause(page, 800);
	await letter.getByRole('button', { name: 'Upload letter' }).click();
	await expect(exit.getByTestId('exit-letter').filter({ hasText: 'Experience certificate' })).toBeVisible();
	await pause(page, 1500);
	await signOut(page);

	await chapter(
		page,
		'6. Running the company',
		'The owner approves money, tracks projects and assets, and reads the reports.'
	);
	await signIn(page, 'owner@demo.local');
	await go(page, 'Salaries');
	const pending = page.getByTestId('salary-change').filter({ hasText: 'Imran Hossain' });
	await caption(page, 'Approve with the memo', 'The approver opens the memo, then approves the new salary.');
	await pending.locator('summary').click();
	await pause(page, 1500);
	await pending.getByRole('button', { name: 'Approve salary of Imran Hossain' }).click();
	await page.waitForLoadState('load');
	await pause(page, 1200);
	await go(page, 'Payroll');
	await caption(
		page,
		'Payroll',
		'Monthly runs with tax, provident fund, loans and overtime. Draft, approve, then publish.'
	);
	await page.locator('a[href*="payroll?run="]').first().click();
	await page.waitForLoadState('load');
	await scrollThrough(page, 3);

	await go(page, 'Projects');
	await page.getByRole('link', { name: 'ATLAS' }).click();
	await page.waitForLoadState('load');
	await attach(page, page.getByRole('region', { name: 'Documents' }), ['atlas-sow-signed.pdf'], false, [
		'Projects',
		'Team allocation, timesheets, and the signed contract with the project.'
	]);
	await go(page, 'Assets');
	await page.getByRole('link', { name: 'LAP-001' }).click();
	await page.waitForLoadState('load');
	await attach(page, page.getByRole('region', { name: 'Attachments' }), ['lap-001-invoice.pdf'], false, [
		'Assets',
		'Who holds which laptop, its history, and the purchase invoice.'
	]);
	await visit(
		page,
		'Meal bills',
		'Meal bills',
		'Generated by a background worker; cash bills keep their payment receipts.'
	);
	await visit(page, 'Reports', 'Reports', 'Headcount, leave, attendance and payroll reports with CSV export.');
	await go(page, 'Settings');
	await page.getByRole('link', { name: 'Audit log' }).first().click();
	await page.waitForLoadState('load');
	await caption(page, 'Audit log', 'Database triggers record every change, including each file attached today.');
	await scrollThrough(page, 2);

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(page.url().replace(/\/settings\/audit.*/, ''));
	await caption(page, 'Fully responsive', 'The same app on a phone.');
	await page.getByRole('button', { name: 'Menu' }).click();
	await pause(page, 1500);
	await page.getByRole('button', { name: 'Close' }).click();
	await scrollThrough(page, 3);
	await page.setViewportSize({ width: 1440, height: 900 });
	await chapter(
		page,
		'HRMS Pro',
		'SvelteKit, Postgres RLS, Redis, BullMQ, MinIO, Docker. 690+ unit, integration and e2e tests.'
	);
});
