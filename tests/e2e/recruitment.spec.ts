import { expect, test } from '@playwright/test';
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
