import { expect, test } from '@playwright/test';
import { waitForMail } from '../mailpit';
import { fixture, signIn } from './fixtures';

test('HR adds an employee, moves them and finds them in the list', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	await page.getByRole('link', { name: 'Organisation' }).click();
	const depts = page.getByRole('region', { name: 'Departments' });
	for (const name of ['Engineering', 'Sales']) {
		await depts.getByLabel('New department name').fill(name);
		await depts.getByRole('button', { name: 'Add' }).click();
		await expect(depts).toContainText(name);
	}

	await page.getByRole('link', { name: 'Employees' }).click();
	await page.getByRole('link', { name: 'New employee' }).click();
	await page.getByLabel('Full name').fill('Rahim Uddin');
	await page.getByLabel('Work email').fill('rahim@acme.test');
	await page.getByLabel('Department').selectOption({ label: 'Engineering' });
	await page.getByLabel('Join date').fill('2026-02-01');
	await page.getByLabel('National ID').fill('1987654321');
	await page.getByRole('button', { name: 'Add employee' }).click();

	await expect(page.getByRole('heading', { name: 'Rahim Uddin' })).toBeVisible();
	await expect(page.getByTestId('fact-Code')).toHaveText('EMP-0001');
	await expect(page.getByText('1987654321').first()).toBeVisible();

	await page.getByLabel('Department').selectOption({ label: 'Sales' });
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('status')).toHaveText('Employee saved.');
	await expect(page.getByTestId('fact-Department')).toHaveText('Sales');
	await expect(page.getByTestId('history')).toContainText('Engineering → Sales');

	await page.getByRole('link', { name: 'Back to employees' }).click();
	await page.getByLabel('Search').fill('rahim@');
	await page.getByRole('button', { name: 'Filter' }).click();
	await expect(page.getByTestId('employee-total')).toHaveText('1');
	await expect(page.getByRole('link', { name: 'Rahim Uddin' })).toBeVisible();
});

test('an employee sees only their own record and cannot edit its HR fields', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'staff', employee: true },
			{ key: 'peer', employee: true }
		]
	});
	await signIn(page, f.users.staff.email);
	await page.getByRole('link', { name: 'Employees' }).click();
	await expect(page.getByTestId('employee-total')).toHaveText('1');
	await expect(page.getByRole('link', { name: 'New employee' })).toHaveCount(0);
	await page.getByRole('link', { name: /^staff / }).click();
	await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
	expect((await page.goto(`/t/${f.tenant!.slug}/employees/${f.users.peer.employeeId}`))!.status()).toBe(404);
	expect((await page.goto(`/t/${f.tenant!.slug}/employees/new`))!.status()).toBe(403);
});

test('an employee keeps their own contact details and emergency contacts', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'staff', employee: true }] });
	await signIn(page, f.users.staff.email);
	await page.goto(`/t/${f.tenant!.slug}/employees/${f.users.staff.employeeId}`);
	await page.getByLabel('My phone').fill('01711222333');
	await page.getByRole('button', { name: 'Save my details' }).click();
	await expect(page.getByRole('status')).toHaveText('Contact details saved.');
	await expect(page.getByTestId('fact-Phone')).toHaveText('01711222333');

	const contacts = page.getByRole('region', { name: 'Emergency contacts' });
	await contacts.getByLabel('Contact name').fill('Rina Akter');
	await contacts.getByLabel('Relation').fill('Sister');
	await contacts.getByLabel('Contact phone').fill('01811000000');
	await contacts.getByRole('button', { name: 'Add to emergency contacts' }).click();
	await expect(page.getByRole('status')).toHaveText('Entry added.');
	await expect(contacts.getByTestId('entry-contact')).toHaveText(/Rina Akter \(Sister\)/);
	await contacts.getByRole('button', { name: /^Remove Rina Akter/ }).click();
	await expect(contacts.getByTestId('entry-contact')).toHaveCount(0);
});

test('an employee asks for a bank change that HR approves and the employee is emailed', async ({
	page,
	request,
	browser
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'staff', employee: true },
			{ key: 'hr', roles: ['hr_admin'] }
		]
	});
	await signIn(page, f.users.staff.email);
	await page.goto(`/t/${f.tenant!.slug}/employees/${f.users.staff.employeeId}`);
	const ask = page.getByRole('region', { name: 'Request a change' });
	await ask.getByLabel('Bank account number').fill('0011223344');
	await ask.getByRole('button', { name: 'Send to HR' }).click();
	await expect(page.getByRole('status')).toHaveText('Your request was sent to HR.');
	await expect(page.getByTestId('pending-change')).toContainText('Bank account number');

	const hr = await browser.newPage();
	await signIn(hr, f.users.hr.email);
	await hr.getByRole('link', { name: 'Approvals' }).click();
	await hr.getByRole('link', { name: /Bank account number/ }).click();
	await expect(hr.getByTestId('change-row')).toContainText('0011223344');
	await hr.getByRole('button', { name: 'Approve' }).click();
	await expect(hr.getByRole('status')).toHaveText('Decision saved.');
	await hr.goto(`/t/${f.tenant!.slug}/employees/${f.users.staff.employeeId}`);
	await expect(hr.getByText('0011223344').first()).toBeVisible();

	expect((await waitForMail(f.users.staff.email, 15_000, 'Your bank details were changed')).text).toContain(
		'tell HR right away'
	);
	await page.reload();
	await expect(page.getByTestId('pending-change')).toHaveCount(0);
});

test('HR links a member to an employee record and the member then sees it', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [{ key: 'hr', roles: ['hr_admin'] }, { key: 'staff' }]
	});
	await signIn(page, f.users.hr.email);
	await page.getByRole('link', { name: 'Employees' }).click();
	await page.getByRole('link', { name: 'New employee' }).click();
	await page.getByLabel('Full name').fill('Karim Staff');
	await page.getByLabel('Join date').fill('2026-03-01');
	await page.getByRole('button', { name: 'Add employee' }).click();
	await expect(page.getByRole('heading', { name: 'Karim Staff' })).toBeVisible();

	await page.getByRole('link', { name: 'Settings', exact: true }).click();
	await page.getByRole('link', { name: 'Users' }).click();
	await page.getByRole('link', { name: /^staff / }).click();
	await page.getByLabel('Linked employee').selectOption({ label: 'Karim Staff (EMP-0001)' });
	await page.getByRole('button', { name: 'Save link' }).click();
	await expect(page.getByRole('status')).toHaveText('Employee record linked.');
	await page.getByRole('link', { name: 'Back to users' }).click();
	await expect(page.getByRole('row', { name: /staff/ })).toContainText('Karim Staff (EMP-0001)');

	await page.context().clearCookies();
	await signIn(page, f.users.staff.email);
	await page.getByRole('link', { name: 'Employees' }).click();
	await expect(page.getByTestId('employee-total')).toHaveText('1');
	await expect(page.getByRole('link', { name: 'Karim Staff' })).toBeVisible();
});

test('HR uploads a document that only its owner and HR can download', async ({ page, request, browser }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'] },
			{ key: 'staff', employee: true },
			{ key: 'peer', employee: true }
		]
	});
	await signIn(page, f.users.hr.email);
	const profile = `/t/${f.tenant!.slug}/employees/${f.users.staff.employeeId}`;
	await page.goto(profile);
	const docs = page.getByRole('region', { name: 'Documents' });
	await docs.getByLabel('Document type').selectOption('contract');
	await docs.getByLabel('Document title').fill('Signed contract');
	await docs.getByLabel('File').setInputFiles({
		name: 'contract.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from('%PDF-1.7 e2e')
	});
	await docs.getByRole('button', { name: 'Upload document' }).click();
	await expect(page.getByRole('status')).toHaveText('Document uploaded.');
	const href = await docs.getByRole('link', { name: 'Signed contract' }).getAttribute('href');

	await docs
		.getByLabel('File')
		.setInputFiles({ name: 'evil.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ') });
	await docs.getByLabel('Document title').fill('Fake');
	await docs.getByRole('button', { name: 'Upload document' }).click();
	await expect(docs.getByRole('alert')).toHaveText('Upload a PDF, image, Word or Excel file.');

	for (const [key, status] of [
		['staff', 200],
		['peer', 404]
	] as const) {
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		await signIn(p, f.users[key].email);
		await expect(p.getByRole('link', { name: 'Employees' })).toBeVisible();
		const res = await p.request.get(href!);
		expect(res.status()).toBe(status);
		if (status === 200) {
			expect(res.headers()['content-disposition']).toContain('attachment');
			expect(await res.text()).toBe('%PDF-1.7 e2e');
		}
		await ctx.close();
	}
});

test('HR imports employees from CSV and exports the list', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'hr', roles: ['hr_admin'] }] });
	await signIn(page, f.users.hr.email);
	await page.getByRole('link', { name: 'Employees' }).click();
	await page.getByRole('link', { name: 'Import CSV' }).click();
	const upload = async (body: string) => {
		await page
			.getByLabel('CSV file')
			.setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(body) });
		await page.getByRole('button', { name: 'Import' }).click();
	};
	const header = 'full_name,work_email,manager_email,employment_type,status,join_date';
	await upload(
		`${header}\nAyesha,ayesha@acme.test,,full_time,active,2026-01-01\nNoor,,ghost@acme.test,full_time,active,2026-01-01\n`
	);
	await expect(page.getByTestId('import-error')).toHaveText(/Line 3: No employee has the manager email/);
	await upload(
		`${header}\nAyesha,ayesha@acme.test,,full_time,active,2026-01-01\nNoor,,ayesha@acme.test,full_time,active,2026-01-01\n`
	);
	await expect(page.getByRole('status')).toHaveText('2 employees imported.');

	await page.getByRole('link', { name: 'Back to employees' }).click();
	await expect(page.getByTestId('employee-total')).toHaveText('2');
	const href = await page.getByRole('link', { name: 'Export CSV' }).getAttribute('href');
	const res = await page.request.get(href!);
	expect(res.headers()['content-type']).toContain('text/csv');
	const text = await res.text();
	expect(text.charCodeAt(0)).toBe(0xfeff);
	expect(text).toMatch(/EMP-0002,Noor,,.*ayesha@acme\.test/);
});
