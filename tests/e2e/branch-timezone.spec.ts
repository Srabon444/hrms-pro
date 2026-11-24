import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('an owner gives a branch its own time zone and clears it again', async ({ page, request }) => {
	const f = await fixture(request, { tenant: {}, users: [{ key: 'own', roles: ['owner'], employee: true }] });
	await signIn(page, f.users.own.email);
	await page.goto(`/t/${f.tenant!.slug}/org`);
	const branches = page.getByRole('region', { name: 'Branches' });
	await branches.getByLabel('New branch name').fill('Dubai office');
	await branches.getByLabel('New branch time zone').selectOption('Asia/Dubai');
	await branches.getByRole('button', { name: 'Add', exact: true }).click();
	const zone = branches.getByLabel('Time zone of Dubai office');
	await expect(zone).toHaveValue('Asia/Dubai');
	await zone.selectOption('');
	await branches
		.getByRole('listitem')
		.filter({ has: page.getByLabel('Time zone of Dubai office') })
		.getByRole('button', { name: 'Save' })
		.click();
	await page.reload();
	await expect(branches.getByLabel('Time zone of Dubai office')).toHaveValue('');
});
