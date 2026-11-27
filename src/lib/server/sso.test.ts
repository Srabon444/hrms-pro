import { describe, expect, it } from 'vitest';
import { checkIdToken, SSO_MESSAGES, ssoMessage } from './sso';

const TID = '1b2c3d4e-0000-4000-8000-0123456789ab';
const jwt = (claims: Record<string, unknown>) =>
	[{ alg: 'RS256' }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.') + '.sig';
const t = Math.floor(Date.now() / 1000);
const google = { provider: 'google', clientId: 'cid', entraTenantId: null };
const entra = { provider: 'entra', clientId: 'cid', entraTenantId: TID };
const base = { aud: 'cid', iat: t, exp: t + 300, nonce: 'n1' };
const g = (extra: Record<string, unknown> = {}) =>
	jwt({
		...base,
		iss: 'https://accounts.google.com',
		sub: '42',
		email: 'Ada@X.Example',
		email_verified: true,
		...extra
	});
const e = (extra: Record<string, unknown> = {}) =>
	jwt({
		...base,
		iss: `https://login.microsoftonline.com/${TID}/v2.0`,
		tid: TID,
		oid: 'o-1',
		sub: 'pairwise',
		...extra
	});
const code = (fn: () => unknown) => {
	try {
		fn();
		return 'ok';
	} catch (err) {
		return (err as { code?: string }).code;
	}
};

describe('checkIdToken', () => {
	it('reads a Google token', () => {
		expect(checkIdToken(google, g(), 'n1')).toEqual({
			issuer: 'https://accounts.google.com',
			subject: '42',
			email: 'ada@x.example',
			name: 'ada'
		});
		expect(code(() => checkIdToken(google, g({ iss: 'accounts.google.com' }), 'n1'))).toBe('ok');
		expect(code(() => checkIdToken(google, g({ aud: ['cid', 'x'], azp: 'cid' }), 'n1'))).toBe('ok');
		expect(code(() => checkIdToken(google, g({ exp: t - 60 }), 'n1'))).toBe('ok');
	});

	it('rejects a Google token that is not for us or not proven', () => {
		for (const bad of [
			g({ aud: 'other' }),
			g({ aud: ['cid', 'x'] }),
			g({ exp: t - 300 }),
			g({ exp: undefined }),
			g({ iat: t + 600 }),
			g({ nonce: undefined }),
			g({ email_verified: undefined }),
			g({ sub: 42 }),
			g({ email: 'not-an-email' }),
			g({ iss: `https://login.microsoftonline.com/${TID}/v2.0` }),
			'not.a.jwt',
			''
		])
			expect(code(() => checkIdToken(google, bad, 'n1'))).toBe('sso_failed');
		expect(code(() => checkIdToken(google, g(), 'n2'))).toBe('sso_failed');
	});

	it('reads an Entra token by directory and object id', () => {
		expect(checkIdToken(entra, e({ preferred_username: 'bo@corp.example', name: ' Bo ' }), 'n1')).toEqual({
			issuer: `https://login.microsoftonline.com/${TID}/v2.0`,
			subject: `${TID}:o-1`,
			email: 'bo@corp.example',
			name: 'Bo'
		});
		expect(checkIdToken(entra, e({ email: 'b@corp.example', preferred_username: 'x' }), 'n1').email).toBe(
			'b@corp.example'
		);
	});

	it('rejects an Entra token from another directory or without an object id', () => {
		const other = '00000000-0000-4000-8000-000000000000';
		for (const bad of [
			e({ email: 'b@corp.example', tid: other }),
			e({ email: 'b@corp.example', iss: `https://login.microsoftonline.com/${other}/v2.0` }),
			e({ email: 'b@corp.example', oid: undefined }),
			e({ email: 'b@corp.example', iss: 'https://login.microsoftonline.com/common/v2.0' }),
			e({ preferred_username: 'no-at-sign' })
		])
			expect(code(() => checkIdToken(entra, bad, 'n1'))).toBe('sso_failed');
	});

	it('has a message for every code the callback can send', () => {
		for (const k of ['sso_failed', 'sso_expired', 'sso_cancelled', 'sso_unlinked', 'sso_taken', 'unavailable'])
			expect(SSO_MESSAGES[k]).toBeTruthy();
		for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nope'])
			expect(ssoMessage(k)).toBe(SSO_MESSAGES.sso_failed);
		expect(ssoMessage(null)).toBeNull();
		expect(ssoMessage('sso_expired')).toBe(SSO_MESSAGES.sso_expired);
	});
});
