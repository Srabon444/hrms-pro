import { expect, test } from '@playwright/test';

test('health endpoints respond and security headers are set', async ({ request }) => {
	const health = await request.get('/healthz');
	expect(health.status()).toBe(200);
	const ready = await request.get('/readyz');
	expect(ready.status(), await ready.text()).toBe(200);
	expect((await ready.json()).checks.db.ok).toBe(true);
	expect(health.headers()['x-content-type-options']).toBe('nosniff');
	expect(health.headers()['x-request-id']).toBeTruthy();
});

test('metrics require the bearer token', async ({ request }) => {
	expect((await request.get('/metrics')).status()).toBe(401);
	const ok = await request.get('/metrics', { headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}` } });
	expect(ok.status()).toBe(200);
	expect(await ok.text()).toContain('hrms_http_request_duration_seconds');
});

test('landing page renders with a CSP header', async ({ page }) => {
	const res = await page.goto('/');
	expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
	await expect(page).toHaveURL(/\/login/);
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a form post with a non-form body is refused, not a server error', async ({ request, baseURL }) => {
	const res = await request.post('/login', {
		headers: { 'content-type': 'text/plain', origin: baseURL! },
		data: 'email=x'
	});
	expect(res.status()).toBe(415);
});
