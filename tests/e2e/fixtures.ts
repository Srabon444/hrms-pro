import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export const PASSWORD = 'e2e correct horse battery';

export type Fixture = {
	tenant: { id: string; slug: string; name: string } | null;
	users: Record<string, { id: string; email: string; employeeId?: string }>;
};

export async function fixture(
	request: APIRequestContext,
	body: {
		tenant?: { name?: string; require2fa?: boolean };
		users: {
			key: string;
			roles?: string[];
			member?: boolean;
			platformAdmin?: boolean;
			employee?: boolean;
			manager?: string;
			totpSecret?: string;
		}[];
	}
): Promise<Fixture> {
	const res = await request.post('/api/test/fixture', { data: { password: PASSWORD, ...body } });
	expect(res.status(), await res.text()).toBe(200);
	return res.json();
}

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
	await page.goto('/login');
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}
