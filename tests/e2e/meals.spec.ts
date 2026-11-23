import { expect, test } from '@playwright/test';
import { fixture, signIn } from './fixtures';

test('a meal manager sets up lunch and chooses it with guests', async ({ page, request }) => {
	const f = await fixture(request, {
		tenant: {},
		users: [{ key: 'mm', roles: ['meal_manager', 'employee'], employee: true }]
	});
	await signIn(page, f.users.mm.email);
	await page.goto(`/t/${f.tenant!.slug}`);
	await page.getByRole('link', { name: 'Meal setup', exact: true }).click();
	const caterer = page.getByRole('region', { name: 'New caterer' });
	await caterer.getByLabel('Caterer name').fill('Rice Bowl');
	await caterer.getByRole('button', { name: 'Add caterer' }).click();
	await expect(page.getByRole('status')).toHaveText('Meal setup saved.');

	const meal = page.getByRole('region', { name: 'New meal' });
	await meal.getByLabel('Meal name').fill('Lunch');
	await meal.getByRole('combobox').selectOption({ label: 'Rice Bowl' });
	await meal.getByRole('button', { name: 'Add meal' }).click();
	const lunch = page.getByRole('region', { name: 'Lunch' });
	await expect(lunch.getByTestId('meal-price')).toHaveText('Rice Bowl · no price yet');

	await lunch.getByLabel('Price per plate (৳)').fill('80.5');
	await lunch.getByLabel('Company pays (%)').fill('50');
	await lunch.getByRole('button', { name: 'Set price for Lunch' }).click();
	await expect(lunch.getByTestId('meal-price')).toHaveText('Rice Bowl · ৳80.50 per plate, company pays 50%');

	await page.getByRole('link', { name: 'Meals', exact: true }).click();
	const save = page.getByRole('button', { name: /^Save Lunch on / });
	const day = page.getByRole('region', { name: 'My meals' }).getByTestId('meal-day').filter({ has: save }).first();
	await day.getByRole('combobox').selectOption('opted_out');
	await day.getByLabel('Guests').fill('2');
	await day.getByRole('button', { name: /^Save Lunch on / }).click();
	await expect(page.getByRole('status')).toHaveText('Meal saved.');
	await expect(day.getByRole('combobox')).toHaveValue('opted_out');
	await expect(day.getByLabel('Guests')).toHaveValue('2');
	await expect(page.getByRole('region', { name: 'Daily meals' })).toBeVisible();
});
