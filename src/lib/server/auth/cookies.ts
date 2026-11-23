import type { Cookies } from '@sveltejs/kit';

export const SESSION_COOKIE = 'hrms_session';
export const CHALLENGE_COOKIE = 'hrms_chal';
export const DEVICE_COOKIE = 'hrms_device';
export const LAST_TENANT_COOKIE = 'hrms_last_tenant';

const base = (url: URL) => ({ path: '/', httpOnly: true, sameSite: 'lax' as const, secure: url.protocol === 'https:' });

export function setSessionCookies(
	cookies: Cookies,
	url: URL,
	s: { token: string; expiresAt: Date; trustedDevice?: string }
) {
	cookies.set(SESSION_COOKIE, s.token, { ...base(url), expires: s.expiresAt });
	if (s.trustedDevice) cookies.set(DEVICE_COOKIE, s.trustedDevice, { ...base(url), maxAge: 30 * 24 * 3600 });
	cookies.delete(CHALLENGE_COOKIE, base(url));
}

export const setChallengeCookie = (cookies: Cookies, url: URL, id: string) =>
	cookies.set(CHALLENGE_COOKIE, id, { ...base(url), maxAge: 600 });

export function clearSessionCookies(cookies: Cookies, url: URL) {
	cookies.delete(SESSION_COOKIE, base(url));
	cookies.delete(CHALLENGE_COOKIE, base(url));
}

export const setLastTenant = (cookies: Cookies, url: URL, slug: string) =>
	cookies.set(LAST_TENANT_COOKIE, slug, { ...base(url), maxAge: 180 * 24 * 3600 });

const unsafeChar = (c: string) => c === '\\' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f;

export const safeNext = (next: string | null | undefined): string =>
	next && next.startsWith('/') && next[1] !== '/' && ![...next].some(unsafeChar) ? next : '/';
