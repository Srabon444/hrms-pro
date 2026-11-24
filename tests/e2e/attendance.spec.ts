import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('HR adds a night shift and assigns it to an employee', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Settings', exact: true }).click();
	await page.getByRole('link', { name: 'Shifts', exact: true }).click();
	const add = page.getByRole('region', { name: 'New shift' });
	await add.getByLabel('Name').fill('Night');
	await add.getByLabel('Starts').fill('22:00');
	await add.getByLabel(/^Ends/).fill('06:00');
	await add.getByLabel('Minutes for a full day').fill('420');
	await add.getByRole('button', { name: 'Add shift' }).click();
	await expect(page.getByRole('status')).toHaveText('Shifts saved.');
	await expect(page.getByRole('region', { name: 'Night' }).getByRole('heading')).toContainText('22:00–06:00');

	await page.goto(`/t/${slug}/employees/${f.users.ela.employeeId}`);
	const shift = page.getByRole('region', { name: 'Shift' });
	await expect(shift.getByTestId('current-shift')).toHaveText('General · 09:00–18:00');
	await shift.getByRole('combobox').selectOption({ label: 'Night' });
	await shift.getByLabel('Starting').fill('2026-01-05');
	await shift.getByRole('button', { name: 'Assign shift' }).click();
	await expect(page.getByRole('status')).toHaveText('Shift saved.');
	await expect(shift.getByTestId('current-shift')).toHaveText('Night · 22:00–06:00');
	await expect(shift.getByTestId('shift-assignment')).toHaveText([/From 2026-01-05: Night/]);
	await shift.getByRole('button', { name: 'Remove shift from 2026-01-05' }).click();
	await expect(shift.getByTestId('current-shift')).toHaveText('General · 09:00–18:00');
});

test('an employee punches in and their manager sees it on the team view', async ({ page, browser, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'boss', roles: ['line_manager'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true, manager: 'boss' }
		]
	});
	const slug = f.tenant!.slug;
	await signIn(page, f.users.ela.email);
	await page.goto(`/t/${slug}`);
	await page.getByRole('link', { name: 'Attendance', exact: true }).click();
	const today = page.getByRole('region', { name: 'Today' });
	await expect(today.getByTestId('today-status')).toHaveText('Not in yet');
	await expect(page.getByRole('region', { name: 'Team' })).toHaveCount(0);
	await today.getByRole('button', { name: 'Punch in' }).click();
	await expect(page.getByRole('status')).toHaveText('Punch recorded.');
	await expect(today.getByTestId('today-status')).toHaveText(/^(Present|Late|Absent)$/);
	await expect(today.getByTestId('punch')).toHaveCount(1);
	await today.getByRole('button', { name: 'Punch out' }).click();
	await expect(page.getByRole('alert')).toHaveText('You punched less than a minute ago.');
	await expect(today.getByTestId('punch')).toHaveCount(1);
	const day = (await today.getByRole('heading').textContent())!.match(/\d{4}-\d{2}-\d{2}/)![0];
	await expect(page.getByRole('region', { name: 'My month' }).getByTestId('attendance-day')).toContainText([
		new RegExp(`${day}\\s*(Present|Late|Absent)`)
	]);

	const ctx = await browser.newContext();
	const boss = await ctx.newPage();
	await signIn(boss, f.users.boss.email);
	await boss.goto(`/t/${slug}/attendance?date=${day}`);
	const team = boss.getByRole('region', { name: 'Team' });
	await expect(team.getByTestId('team-day').filter({ hasText: /^ela / })).toContainText(/Present|Late|Absent/);
	await expect(team.getByRole('button', { name: 'Add punch' })).toHaveCount(0);
	await ctx.close();
});

const workday = (offset: number) => {
	const d = new Date(Date.now() + offset * 86_400_000);
	while ([5, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
};

test('an employee asks to work from home, the manager approves and the employee cancels', async ({
	page,
	browser,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'boss', roles: ['line_manager'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true, manager: 'boss' }
		]
	});
	const slug = f.tenant!.slug;
	const date = workday(7);
	await signIn(page, f.users.ela.email);
	await page.goto(`/t/${slug}/attendance`);
	const ask = page.getByRole('region', { name: 'Ask for a change' });
	await ask.getByRole('combobox').selectOption({ label: 'Work from home' });
	await ask.getByLabel('Day', { exact: true }).fill(date);
	await ask.getByLabel('Reason').fill('Plumber visit');
	await ask.getByRole('button', { name: 'Send request' }).click();
	await expect(page.getByRole('status')).toHaveText('Request sent.');
	const mine = ask.getByTestId('attendance-request');
	await expect(mine).toHaveText([`Work from home on ${date} · pending`]);
	const pBox = ask.getByRole('group', { name: 'Proof' });
	await pBox.getByText('Proof (0)').click();
	await pBox
		.getByLabel('Files to attach')
		.setInputFiles({ name: 'plumber.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 plumber.pdf') });
	await pBox.getByRole('button', { name: 'Attach files' }).click();
	await expect(pBox.getByTestId('attachment')).toContainText('plumber.pdf');

	const ctx = await browser.newContext();
	const boss = await ctx.newPage();
	await signIn(boss, f.users.boss.email);
	await boss.goto(`/t/${slug}/approvals`);
	await boss.getByRole('link', { name: new RegExp(`Work from home on ${date}`) }).click();
	await expect(boss.getByRole('heading', { level: 1 })).toHaveText(/Work from home for ela/);
	await expect(boss.getByTestId('attachment')).toContainText('plumber.pdf');
	await expect(boss.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
	await boss.getByRole('button', { name: 'Approve' }).click();
	await expect(boss.getByRole('status')).toHaveText('Decision saved.');
	await ctx.close();

	await page.reload();
	await expect(mine).toHaveText([`Work from home on ${date} · approved`]);
	await page.getByRole('button', { name: `Cancel Work from home on ${date}` }).click();
	await expect(page.getByRole('status')).toHaveText('Request cancelled.');
	await expect(mine).toHaveText([`Work from home on ${date} · cancelled`]);
});

test('HR imports device punches from a CSV file', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'hr', roles: ['hr_admin'], employee: true },
			{ key: 'ela', roles: ['employee'], employee: true }
		]
	});
	await signIn(page, f.users.hr.email);
	await page.goto(`/t/${f.tenant!.slug}/attendance?date=2026-02-02`);
	const team = page.getByRole('region', { name: 'Team' });
	const upload = (body: string) =>
		team
			.getByLabel(/Device punches/)
			.setInputFiles({ name: 'device.csv', mimeType: 'text/csv', buffer: Buffer.from(body) });
	await upload('employee_code,timestamp\nE2E-ELA,2026-02-02 09:00\nE2E-NOBODY,2026-02-02 09:00\n');
	await team.getByRole('button', { name: 'Import punches' }).click();
	await expect(page.getByTestId('import-error')).toHaveText(['Line 3: Unknown employee code.']);
	await upload('employee_code,timestamp\nE2E-ELA,2026-02-02 09:00\nE2E-ELA,2026-02-02 18:00\n');
	await team.getByRole('button', { name: 'Import punches' }).click();
	await expect(page.getByRole('status')).toHaveText('2 punches imported, 0 already recorded or repeated.');
	await page.goto(`/t/${f.tenant!.slug}/attendance?date=2026-02-02`);
	await expect(team.getByTestId('team-day').filter({ hasText: 'ela' })).toContainText('Present · 09:00–18:00 · 9h 00m');
});
