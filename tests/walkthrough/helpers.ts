import type { Page } from '@playwright/test';

export const PASSWORD = process.env.SEED_PASSWORD ?? '';

export async function caption(page: Page, title: string, detail = '') {
	await page.evaluate(
		([t, d]) => {
			document.getElementById('walk-caption')?.remove();
			const box = document.createElement('div');
			box.id = 'walk-caption';
			box.style.cssText =
				'position:fixed;right:24px;bottom:24px;z-index:9999;max-width:560px;padding:14px 18px;border-radius:12px;background:rgba(10,34,28,.92);color:#fff;font:500 18px/1.35 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);pointer-events:none';
			box.innerHTML = `<div style="font-weight:700">${t}</div>${d ? `<div style="margin-top:4px;font-weight:400;font-size:15px;opacity:.85">${d}</div>` : ''}`;
			document.body.append(box);
		},
		[title, detail]
	);
	await page.waitForTimeout(3200);
}

export async function pause(page: Page, ms = 1500) {
	await page.waitForTimeout(ms);
}

export async function scrollThrough(page: Page, steps = 3) {
	for (let i = 0; i < steps; i++) {
		await page.mouse.wheel(0, 380);
		await page.waitForTimeout(700);
	}
	await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
	await page.waitForTimeout(600);
}

export async function signIn(page: Page, email: string) {
	await page.goto('/login');
	await page.getByLabel('Email').pressSequentially(email, { delay: 40 });
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

export async function signOut(page: Page) {
	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.waitForURL(/\/login/);
}
