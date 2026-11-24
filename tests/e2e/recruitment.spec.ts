import { expect, test } from '@playwright/test';
import { waitForMail } from '../mailpit';
import { fixture, signIn } from './fixtures';

test('a recruiter opens a job, adds a candidate with a resume and moves them along', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'rec', roles: ['recruiter'] },
			{ key: 'emp', roles: ['employee'], employee: true }
		]
	});
	await signIn(page, f.users.rec.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Recruitment', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Recruitment' })).toBeVisible();
	const open = page.getByRole('region', { name: 'New opening' });
	await open.getByLabel('Job title').fill('Backend engineer');
	await open.getByLabel('Headcount').fill('2');
	await open.getByRole('button', { name: 'Open position' }).click();
	await expect(page.getByRole('heading', { name: 'Backend engineer · Open' })).toBeVisible();
	await page.waitForSelector('html[data-hydrated]');

	const add = page.getByRole('region', { name: 'Add candidate' });
	await add.getByLabel('Full name').fill('Rafi Ahmed');
	await add.getByLabel('Email').fill('not-an-email');
	await add.getByRole('button', { name: 'Add candidate' }).click();
	await expect(add.getByLabel('Email')).toHaveJSProperty('validity.valid', false);
	await add.getByLabel('Email').fill('rafi@example.com');
	await add.getByLabel('Source').selectOption('Referral');
	await add.getByLabel('Tags (comma separated)').fill('go, sql');
	await add
		.getByLabel('Resume (PDF or Word, up to 10 MB)')
		.setInputFiles({ name: 'rafi.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 rafi') });
	await add.getByRole('button', { name: 'Add candidate' }).click();
	await expect(page.getByRole('status')).toHaveText('Candidate added.');
	const applied = page.getByRole('group', { name: 'Applied' });
	await expect(applied).toContainText('Applied 1');

	await applied.getByRole('link', { name: 'Rafi Ahmed' }).click();
	await expect(page.getByRole('heading', { name: 'Rafi Ahmed · Applied' })).toBeVisible();
	await page.waitForSelector('html[data-hydrated]');
	const download = page.waitForEvent('download');
	await page.getByRole('link', { name: 'rafi.pdf' }).click();
	expect((await download).suggestedFilename()).toBe('rafi.pdf');
	const move = page.getByRole('region', { name: 'Move candidate' });
	await expect(move.getByLabel('Stage').locator('option')).toHaveText(['Screening', 'Interview', 'Offer', 'Rejected']);
	await move.getByLabel('Stage').selectOption('Screening');
	await move.getByLabel('Note').fill('Strong CV');
	await move.getByRole('button', { name: 'Move' }).click();
	await expect(page.getByRole('status')).toHaveText('Candidate moved.');
	await expect(page.getByRole('heading', { name: 'Rafi Ahmed · Screening' })).toBeVisible();
	const history = page.getByRole('region', { name: 'History' }).getByRole('listitem');
	await expect(history).toHaveCount(2);
	await expect(history.nth(0)).toContainText('Applied → Screening · Strong CV');
	await expect(history.nth(1)).toContainText('Added to Applied');

	await page.context().clearCookies();
	await signIn(page, f.users.emp.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await expect(page.getByRole('link', { name: 'Recruitment', exact: true })).toHaveCount(0);
	const res = await page.goto(`/t/${f.tenant!.slug}/recruitment`);
	expect(res?.status()).toBe(403);
});

test('a candidate is interviewed, offered and hired into an onboarding employee who gets an invite', async ({
	page,
	request
}) => {
	const f = await fixture(request, {
		tenant: {},
		users: [
			{ key: 'rec', roles: ['recruiter'] },
			{ key: 'ivo', roles: ['hr_officer'] },
			{ key: 'adm', roles: ['hr_admin'] }
		]
	});
	const slug = f.tenant!.slug;
	const mail = `nadia-${slug}@example.com`;
	const as = async (key: string, path: string) => {
		await page.context().clearCookies();
		await signIn(page, f.users[key].email);
		await page.goto(`/t/${slug}/${path}`);
		await page.waitForSelector('html[data-hydrated]');
	};

	await as('rec', 'recruitment');
	const open = page.getByRole('region', { name: 'New opening' });
	await open.getByLabel('Job title').fill('Product designer');
	await open.getByRole('button', { name: 'Open position' }).click();
	await expect(page.getByRole('heading', { name: 'Product designer · Open' })).toBeVisible();
	await page.waitForSelector('html[data-hydrated]');
	const add = page.getByRole('region', { name: 'Add candidate' });
	await add.getByLabel('Full name').fill('Nadia Karim');
	await add.getByLabel('Email').fill(mail);
	await add.getByRole('button', { name: 'Add candidate' }).click();
	await expect(page.getByRole('status')).toHaveText('Candidate added.');
	await page.getByRole('link', { name: 'Nadia Karim' }).click();
	await expect(page.getByRole('heading', { name: 'Nadia Karim · Applied' })).toBeVisible();
	await page.waitForSelector('html[data-hydrated]');
	const candidateUrl = page.url();
	const kept = page.getByRole('region', { name: 'Candidate files' });
	await kept
		.getByLabel('Files to attach')
		.setInputFiles({ name: 'nid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 nid') });
	await kept.getByRole('button', { name: 'Attach files' }).click();
	await expect(kept.getByTestId('attachment')).toContainText('nid.pdf');

	const schedule = page.getByRole('region', { name: 'Schedule interview' });
	await schedule.getByLabel('Interview title').fill('Portfolio review');
	await schedule.getByLabel('Date and time').fill('2030-01-10T10:00');
	await schedule.getByRole('button', { name: 'Schedule' }).click();
	await expect(page.getByRole('alert')).toHaveText('Choose at least one interviewer.');
	await schedule.getByLabel('Interview title').fill('Portfolio review');
	await schedule.getByLabel('Date and time').fill('2030-01-10T10:00');
	await schedule.getByRole('checkbox', { name: /^ivo / }).check();
	await schedule.getByRole('button', { name: 'Schedule' }).click();
	await expect(page.getByRole('status')).toHaveText('Interview scheduled. The panel has been notified.');
	await expect(page.getByTestId('interview')).toContainText('Waiting for feedback');
	expect((await waitForMail(f.users.ivo.email)).subject).toBe('Interview: Nadia Karim · Portfolio review');

	await as('ivo', '');
	await page.getByRole('link', { name: 'My interviews', exact: true }).click();
	const card = page.getByRole('listitem', { name: 'Nadia Karim · Portfolio review' });
	await expect(card).toBeVisible();
	await page.waitForSelector('html[data-hydrated]');
	await card.getByLabel('Rating').selectOption('4');
	await card.getByLabel('Recommendation').selectOption('Strong yes');
	await card.getByLabel('Comments').fill('Clear thinking');
	await card.getByRole('button', { name: 'Send feedback' }).click();
	await expect(page.getByRole('status')).toHaveText('Feedback sent.');
	await expect(card).toContainText('You rated 4/5 · Strong yes · Clear thinking');

	await as('rec', candidateUrl.split(`/t/${slug}/`)[1]);
	await expect(page.getByTestId('interview')).toContainText('4/5 · Strong yes · Clear thinking');
	const offer = page.getByRole('region', { name: 'Make offer' });
	await offer.getByLabel('Monthly gross (৳)').fill('90000');
	await offer.getByLabel('Join date').fill('2030-02-01');
	await offer.getByRole('button', { name: 'Record offer' }).click();
	await expect(page.getByRole('status')).toHaveText('Offer recorded.');
	await expect(page.getByTestId('offer')).toContainText('৳90000.00 a month · joins 2030-02-01 · Waiting for an answer');
	await page.getByRole('button', { name: 'Mark accepted' }).click();
	await expect(page.getByTestId('offer')).toContainText('Accepted');
	const letter = page.getByTestId('offer').getByRole('group', { name: 'Offer letter' });
	await letter.getByText('Offer letter (0)').click();
	await letter
		.getByLabel('Files to attach')
		.setInputFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 signed') });
	await letter.getByRole('button', { name: 'Attach files' }).click();
	await expect(page.getByTestId('offer').getByTestId('attachment')).toContainText('signed.pdf');
	await expect(page.getByRole('region', { name: 'Hire' })).toHaveCount(0);

	await as('adm', candidateUrl.split(`/t/${slug}/`)[1]);
	const hire = page.getByRole('region', { name: 'Hire' });
	await expect(hire.getByLabel(`Invite ${mail} to sign in`)).toBeChecked();
	await hire.getByRole('button', { name: 'Hire Nadia Karim' }).click();
	await expect(page.getByRole('status')).toHaveText('Hired. The invite is on its way.');
	await expect(page.getByRole('heading', { name: 'Nadia Karim · Hired' })).toBeVisible();
	expect((await waitForMail(mail)).subject).toMatch(/^You are invited to /);
	await page.getByRole('link', { name: 'Open employee record' }).click();
	await expect(page.getByRole('heading', { name: /Nadia Karim/ })).toBeVisible();
	await expect(page.getByRole('definition').filter({ hasText: /^onboarding$/ })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Files from hiring' }).getByTestId('attachment')).toContainText(
		'nid.pdf'
	);
});
